import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { HistoryEntry, StockItem } from './lib/types.ts';

const STOCK: StockItem[] = [
  {
    itemId: 'yirgacheffe',
    name: 'Yirgacheffe',
    category: 'beans',
    baseUnit: 'g',
    quantity: 12000,
    lastEventAt: '2026-08-15T14:05:00.000Z',
  },
  {
    itemId: 'whole-milk',
    name: 'Whole milk',
    category: 'dairy',
    baseUnit: 'ml',
    quantity: 4000,
    lastEventAt: '2026-08-15T16:20:00.000Z',
  },
  {
    itemId: 'lids-12oz',
    name: '12oz lids',
    category: 'packaging',
    baseUnit: 'each',
    quantity: 8,
    lastEventAt: null,
  },
];

const HISTORY: HistoryEntry[] = [
  {
    sequence: 1,
    eventType: 'StockReceived',
    payload: { itemId: 'yirgacheffe', quantity: 15000, supplier: 'Cafe Imports' },
    occurredAt: '2026-08-10T09:00:00.000Z',
  },
  {
    sequence: 7,
    eventType: 'StockDepleted',
    payload: { itemId: 'yirgacheffe', quantity: 3000, reason: 'sale' },
    occurredAt: '2026-08-15T14:05:00.000Z',
  },
];

/** Stand in for the backend, which is a separate lane and may not be running. */
function mockNetwork(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (match === undefined) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stock board', () => {
  it('renders each item with a human-readable quantity', async () => {
    mockNetwork({ '/api/stock': STOCK });
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Yirgacheffe' })).toBeInTheDocument();
    const board = screen.getByRole('table');
    expect(board).toHaveTextContent('12 kg');
    expect(board).toHaveTextContent('4 L');
    expect(board).toHaveTextContent('packaging');
  });

  it('flags items that are running low', async () => {
    mockNetwork({ '/api/stock': STOCK });
    render(<App />);

    const lidsRow = (await screen.findByRole('button', { name: '12oz lids' })).closest('tr');
    expect(lidsRow).toHaveClass('low');
    expect(lidsRow).toHaveTextContent('low');

    const beansRow = screen.getByRole('button', { name: 'Yirgacheffe' }).closest('tr');
    expect(beansRow).not.toHaveClass('low');
  });

  it('says plainly when the backend is not answering', async () => {
    mockNetwork({});
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/is not answering/);
  });

  it('says the board is blank when nothing is seeded', async () => {
    mockNetwork({ '/api/stock': [] });
    render(<App />);

    expect(await screen.findByText(/no items have been defined yet/i)).toBeInTheDocument();
  });

  it('shows an item history newest first when an item is clicked', async () => {
    mockNetwork({ '/api/stock': STOCK, '/api/items/yirgacheffe/history': HISTORY });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Yirgacheffe' }));

    const ledger = await screen.findByRole('list');
    const tickets = await waitFor(() => {
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      return rows;
    });
    expect(ledger).toBeInTheDocument();
    expect(tickets[0]).toHaveTextContent('StockDepleted');
    expect(tickets[0]).toHaveTextContent('3 kg');
    expect(tickets[0]).toHaveTextContent('sale');
    expect(tickets[1]).toHaveTextContent('StockReceived');
    expect(tickets[1]).toHaveTextContent('15 kg');
  });
});

describe('movement forms', () => {
  /** The body of the most recent POST, already parsed — or undefined if none. */
  function lastPostBody(fetchMock: ReturnType<typeof mockNetwork>): unknown {
    const call = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST').at(-1);
    return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
  }

  it('posts a StockReceived event with an integer base-unit quantity', async () => {
    const fetchMock = mockNetwork({
      '/api/stock': STOCK,
      '/api/events': { eventId: 'e1', sequence: 8 },
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = within(screen.getByRole('form', { name: 'Receive stock' }));
    await userEvent.selectOptions(form.getByLabelText('Item'), 'yirgacheffe');
    await userEvent.selectOptions(form.getByLabelText('Unit'), 'kg');
    await userEvent.type(form.getByLabelText('Quantity'), '2.5');
    await userEvent.click(form.getByRole('button', { name: 'Record delivery' }));

    await waitFor(() => {
      expect(lastPostBody(fetchMock)).toEqual({
        type: 'StockReceived',
        itemId: 'yirgacheffe',
        quantity: 2500,
      });
    });
  });

  it('posts waste as a StockDepleted event with reason "waste"', async () => {
    const fetchMock = mockNetwork({
      '/api/stock': STOCK,
      '/api/events': { eventId: 'e1', sequence: 8 },
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = within(screen.getByRole('form', { name: 'Record waste' }));
    await userEvent.selectOptions(form.getByLabelText('Item'), 'whole-milk');
    await userEvent.type(form.getByLabelText('Quantity'), '750');
    await userEvent.click(form.getByRole('button', { name: 'Record waste' }));

    await waitFor(() => {
      expect(lastPostBody(fetchMock)).toEqual({
        type: 'StockDepleted',
        itemId: 'whole-milk',
        quantity: 750,
        reason: 'waste',
      });
    });
  });

  it("shows the backend's own rejection message when a POST is refused", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/stock')) {
          return new Response(JSON.stringify(STOCK), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_EVENT',
              message: 'quantity must be an integer in the base unit — no floats',
            },
          }),
          { status: 400 },
        );
      }),
    );
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = within(screen.getByRole('form', { name: 'Receive stock' }));
    await userEvent.selectOptions(form.getByLabelText('Item'), 'yirgacheffe');
    await userEvent.type(form.getByLabelText('Quantity'), '500');
    await userEvent.click(form.getByRole('button', { name: 'Record delivery' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'quantity must be an integer in the base unit — no floats',
    );
  });

  it('refuses a fractional each instead of rounding it', async () => {
    const fetchMock = mockNetwork({
      '/api/stock': STOCK,
      '/api/events': { eventId: 'e1', sequence: 8 },
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = within(screen.getByRole('form', { name: 'Record waste' }));
    await userEvent.selectOptions(form.getByLabelText('Item'), 'lids-12oz');
    await userEvent.type(form.getByLabelText('Quantity'), '0.5');
    await userEvent.click(form.getByRole('button', { name: 'Record waste' }));

    expect(await form.findByRole('alert')).toHaveTextContent(/whole number of each/);
    expect(lastPostBody(fetchMock)).toBeUndefined();
  });
});
