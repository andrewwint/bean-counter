import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import type { StockItem } from '../lib/types.ts';

const STOCK: StockItem[] = [
  {
    itemId: 'yirgacheffe',
    name: 'Yirgacheffe',
    category: 'beans',
    baseUnit: 'g',
    quantity: 12000,
    lastEventAt: '2026-08-15T14:05:00.000Z',
  },
];

/** One answer from `POST /api/events`; a factory because a body reads once. */
type EventReply = () => Response;

const appended: EventReply = () =>
  new Response(JSON.stringify({ eventId: 'server-id', sequence: 8 }), { status: 201 });

/** The same handle, seen before: the original write, byte-identical, as a 200. */
const replayed: EventReply = () =>
  new Response(JSON.stringify({ eventId: 'server-id', sequence: 8 }), { status: 200 });

const conflict: EventReply = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'EVENT_ID_CONFLICT',
        message: 'That eventId already recorded a different event.',
      },
    }),
    { status: 409 },
  );

const offline: EventReply = () => {
  throw new TypeError('Failed to fetch');
};

/**
 * Serves the stock board, and answers each `POST /api/events` with the next
 * queued reply (the last one repeats). Returns the `eventId` of every POST
 * body actually put on the wire — the only evidence that matters here.
 */
function mockNetwork(replies: EventReply[]) {
  const postedEventIds: unknown[] = [];
  let next = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/events')) {
        postedEventIds.push((JSON.parse(String(init?.body)) as { eventId?: unknown }).eventId);
        const reply = replies[Math.min(next++, replies.length - 1)];
        if (reply === undefined) throw new Error('no reply queued for POST /api/events');
        return reply();
      }
      if (url.endsWith('/api/stock')) return new Response(JSON.stringify(STOCK), { status: 200 });
      throw new TypeError('Failed to fetch');
    }),
  );

  return postedEventIds;
}

/** Fill in the receive form and press the submit button once. */
async function recordDelivery(kg: string) {
  const form = within(screen.getByRole('form', { name: 'Receive stock' }));
  await userEvent.selectOptions(form.getByLabelText('Item'), 'yirgacheffe');
  await userEvent.selectOptions(form.getByLabelText('Unit'), 'kg');
  await userEvent.type(form.getByLabelText('Quantity'), kg);
  await userEvent.click(form.getByRole('button', { name: 'Record delivery' }));
  return form;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retrying a submission', () => {
  it('sends the same eventId when a failed submission is retried', async () => {
    const postedEventIds = mockNetwork([offline, appended]);
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = await recordDelivery('12');
    expect(await form.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(await form.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(postedEventIds).toHaveLength(2));

    expect(postedEventIds[0]).toEqual(expect.any(String));
    expect(postedEventIds[1]).toBe(postedEventIds[0]);
  });

  it('sends a different eventId for the next entry once one is recorded', async () => {
    const postedEventIds = mockNetwork([appended]);
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = await recordDelivery('12');
    expect(await form.findByText('Delivery recorded.')).toBeInTheDocument();

    // The same 12 kg again: a second real delivery, not a replay of the first.
    await recordDelivery('12');
    await waitFor(() => expect(postedEventIds).toHaveLength(2));

    expect(postedEventIds[1]).toEqual(expect.any(String));
    expect(postedEventIds[1]).not.toBe(postedEventIds[0]);
  });

  it('reads a replayed append as recorded once, not as a failure', async () => {
    mockNetwork([replayed]);
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = await recordDelivery('12');

    expect(await form.findByText(/already recorded/i)).toBeInTheDocument();
    expect(form.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an eventId conflict as an error and does not retry it', async () => {
    const postedEventIds = mockNetwork([conflict]);
    render(<App />);
    await screen.findByRole('button', { name: 'Yirgacheffe' });

    const form = await recordDelivery('12');

    expect(await form.findByRole('alert')).toHaveTextContent(
      'That eventId already recorded a different event.',
    );
    expect(form.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(postedEventIds).toHaveLength(1);
  });
});
