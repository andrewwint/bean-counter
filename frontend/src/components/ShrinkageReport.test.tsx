import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import type { ItemReconciliation, ReconciliationRow, StockItem } from '../lib/types.ts';

const STOCK: StockItem[] = [
  {
    itemId: 'yirgacheffe',
    name: 'Yirgacheffe',
    category: 'beans',
    baseUnit: 'g',
    quantity: 11250,
    lastEventAt: '2026-08-15T14:05:00.000Z',
  },
];

/**
 * As the API delivers it: ranked by `totalVariancePct`, most negative first,
 * with nothing-scorable last. Deliberately not in name order, and not in raw
 * `totalVariance` order either (-4000 g outranks -900 ml on percentage, not on
 * magnitude) — so a stray client-side sort shows up as a different row order.
 */
const REPORT: ReconciliationRow[] = [
  {
    itemId: 'sumatra',
    name: 'Sumatra Mandheling',
    category: 'beans',
    baseUnit: 'g',
    totalVariance: -4000,
    totalVariancePct: -4.2,
    lastCountAt: '2026-08-17T08:00:00.000Z',
    countsRecorded: 3,
  },
  {
    itemId: 'yirgacheffe',
    name: 'Yirgacheffe',
    category: 'beans',
    baseUnit: 'g',
    totalVariance: -250,
    totalVariancePct: -1.55,
    lastCountAt: '2026-08-17T08:05:00.000Z',
    countsRecorded: 2,
  },
  {
    itemId: 'whole-milk',
    name: 'Whole milk',
    category: 'dairy',
    baseUnit: 'ml',
    totalVariance: 0,
    totalVariancePct: 0,
    lastCountAt: '2026-08-17T08:10:00.000Z',
    countsRecorded: 2,
  },
  {
    itemId: 'oat-milk',
    name: 'Oat milk',
    category: 'dairy',
    baseUnit: 'ml',
    totalVariance: 1200,
    totalVariancePct: 3.1,
    lastCountAt: '2026-08-17T08:12:00.000Z',
    countsRecorded: 1,
  },
  {
    itemId: 'lids-12oz',
    name: '12oz lids',
    category: 'packaging',
    baseUnit: 'each',
    totalVariance: 0,
    totalVariancePct: null,
    lastCountAt: null,
    countsRecorded: 0,
  },
];

const YIRGACHEFFE: ItemReconciliation = {
  itemId: 'yirgacheffe',
  name: 'Yirgacheffe',
  baseUnit: 'g',
  counts: [
    {
      sequence: 12,
      occurredAt: '2026-08-10T08:00:00.000Z',
      countedQuantity: 5000,
      // The first ever count: nothing in the log preceded it, so it is an
      // opening balance. There was no prediction to be wrong about, and no
      // denominator — the API sends null for both, never 0 and never Infinity.
      expectedQuantity: 0,
      variance: null,
      variancePct: null,
      isOpeningBalance: true,
    },
    {
      sequence: 31,
      occurredAt: '2026-08-17T08:05:00.000Z',
      countedQuantity: 15850,
      expectedQuantity: 16100,
      variance: -250,
      variancePct: -1.55,
      isOpeningBalance: false,
    },
  ],
  totalVariance: -250,
  sinceLastCount: {
    received: 0,
    depleted: { sale: 4600, waste: 0, sample: 0 },
    expectedQuantity: 11250,
  },
};

/** Counted once, and that count was the opening balance: nothing is scorable. */
const BASELINE_ONLY_REPORT: ReconciliationRow[] = [
  {
    itemId: 'huila',
    name: 'Huila',
    category: 'beans',
    baseUnit: 'g',
    totalVariance: 0,
    totalVariancePct: null,
    lastCountAt: '2026-08-17T08:00:00.000Z',
    countsRecorded: 1,
  },
];

const BASELINE_ONLY: ItemReconciliation = {
  itemId: 'huila',
  name: 'Huila',
  baseUnit: 'g',
  counts: [
    {
      sequence: 4,
      occurredAt: '2026-08-17T08:00:00.000Z',
      countedQuantity: 8000,
      expectedQuantity: 0,
      variance: null,
      variancePct: null,
      isOpeningBalance: true,
    },
  ],
  totalVariance: 0,
  sinceLastCount: {
    received: 0,
    depleted: { sale: 0, waste: 0, sample: 0 },
    expectedQuantity: 8000,
  },
};

const NEVER_COUNTED: ItemReconciliation = {
  itemId: 'lids-12oz',
  name: '12oz lids',
  baseUnit: 'each',
  counts: [],
  totalVariance: 0,
  sinceLastCount: {
    received: 1000,
    depleted: { sale: 343, waste: 0, sample: 0 },
    expectedQuantity: 657,
  },
};

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

/** Open the report the way a user does: from the board. */
async function openReport(routes: Record<string, unknown>) {
  mockNetwork({ '/api/stock': STOCK, ...routes });
  render(<App />);
  await screen.findByRole('button', { name: 'Yirgacheffe' });
  await userEvent.click(screen.getByRole('tab', { name: 'Shrinkage' }));
  return screen.findByRole('region', { name: 'Shrinkage report' });
}

/** Open one item's detail from the report. */
async function openDetail(routes: Record<string, unknown>, name: string) {
  const report = within(await openReport(routes));
  await report.findByRole('table');
  await userEvent.click(report.getByRole('button', { name }));
  return screen.findByRole('region', { name: `Reconciliation for ${name}` });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shrinkage report', () => {
  it('keeps the order the API sent — worst shrinkage first', async () => {
    const report = within(await openReport({ '/api/reconciliation': REPORT }));

    const names = (await report.findAllByRole('row'))
      .slice(1) // header
      .map((row) => within(row).getByRole('button').textContent);

    expect(names).toEqual([
      'Sumatra Mandheling',
      'Yirgacheffe',
      'Whole milk',
      'Oat milk',
      '12oz lids',
    ]);
  });

  it('states shrinkage, overage, reconciling and never-counted in shop words', async () => {
    const report = within(await openReport({ '/api/reconciliation': REPORT }));
    await report.findByRole('table');

    const row = (name: string) => report.getByRole('button', { name }).closest('tr') as HTMLElement;

    expect(row('Sumatra Mandheling')).toHaveTextContent('-4 kg');
    expect(row('Sumatra Mandheling')).toHaveTextContent('short');

    // An overage is signed and named, so nobody reads it as a windfall.
    expect(row('Oat milk')).toHaveTextContent('+1.2 L');
    expect(row('Oat milk')).toHaveTextContent(/delivery not recorded/);
    expect(row('Oat milk')).not.toHaveTextContent('short');

    expect(row('Whole milk')).toHaveTextContent('reconciles');

    // The ranking key is shown, so the order across incomparable units reads.
    expect(row('Sumatra Mandheling')).toHaveTextContent('-4.2%');
    expect(row('12oz lids')).not.toHaveTextContent('%');

    // Zero counts is an absence of evidence, not a variance of zero.
    expect(row('12oz lids')).toHaveTextContent('never counted');
    expect(row('12oz lids')).not.toHaveTextContent('reconciles');
  });

  it('shows the arithmetic behind one item, and a dash where there is no denominator', async () => {
    const report = within(
      await openReport({
        '/api/reconciliation': REPORT,
        '/api/items/yirgacheffe/reconciliation': YIRGACHEFFE,
      }),
    );
    await report.findByRole('table');
    await userEvent.click(report.getByRole('button', { name: 'Yirgacheffe' }));

    const detail = await screen.findByRole('region', { name: 'Reconciliation for Yirgacheffe' });
    const rows = within(detail).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    // Both operands, then the difference — not just a verdict.
    expect(rows[1]).toHaveTextContent('16.1 kg');
    expect(rows[1]).toHaveTextContent('15.85 kg');
    expect(rows[1]).toHaveTextContent('-250 g');
    expect(rows[1]).toHaveTextContent('-1.6%');

    // An opening balance has no denominator, so variancePct is null: a
    // placeholder, never a value.
    expect(rows[0]).toHaveTextContent('—');
    expect(detail.textContent ?? '').not.toMatch(/null|NaN|Infinity|undefined/);
  });

  it('treats an item with no counts as never counted, not as an error', async () => {
    const report = within(
      await openReport({
        '/api/reconciliation': REPORT,
        '/api/items/lids-12oz/reconciliation': NEVER_COUNTED,
      }),
    );
    await report.findByRole('table');
    await userEvent.click(report.getByRole('button', { name: '12oz lids' }));

    const detail = await screen.findByRole('region', { name: 'Reconciliation for 12oz lids' });
    expect(within(detail).getByText(/never counted/i)).toBeInTheDocument();
    expect(within(detail).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(detail).queryByRole('table')).not.toBeInTheDocument();
  });

  it('reads an opening balance as the baseline it is, not as an unparsed variance', async () => {
    const detail = await openDetail(
      { '/api/reconciliation': REPORT, '/api/items/yirgacheffe/reconciliation': YIRGACHEFFE },
      'Yirgacheffe',
    );
    const counts = within(detail).getAllByRole('row').slice(1); // oldest first
    const opening = counts[0] as HTMLElement;

    // What the row is: the count the shop started from, with the quantity.
    expect(opening).toHaveTextContent('opening balance');
    expect(opening).toHaveTextContent('5 kg');
    // What it is not: an unknown, an error, or a variance of zero.
    expect(opening).not.toHaveTextContent('not known');
    expect(opening).not.toHaveTextContent('reconciles');
    expect(opening).not.toHaveTextContent('short');
    expect(within(detail).queryByRole('alert')).not.toBeInTheDocument();

    // Distinct from a real variance in greyscale as well as in colour.
    const cell = within(opening).getByText(/opening balance/);
    expect(cell).toHaveClass('baseline');
    expect(cell.textContent).toContain('◆');
    expect(cell).not.toHaveClass('unknown');

    // The scored row is untouched: signed variance, percentage, its own tone.
    const scored = counts[1] as HTMLElement;
    expect(scored).toHaveTextContent('▼ -250 g short');
    expect(scored).toHaveTextContent('-1.6%');
    expect(within(scored).getByText(/short/)).toHaveClass('short');
  });

  it('does not count an opening balance towards the total it did not contribute to', async () => {
    const detail = await openDetail(
      { '/api/reconciliation': REPORT, '/api/items/yirgacheffe/reconciliation': YIRGACHEFFE },
      'Yirgacheffe',
    );

    // Two count rows, one of them unscored — the total is across one count, and
    // the sentence says so rather than implying the baseline contributed 0.
    expect(within(detail).getAllByRole('row').slice(1)).toHaveLength(2);
    const summary = within(detail).getByText(/Across/);
    expect(summary).toHaveTextContent('Across 1 scored count: ▼ -250 g short');
    expect(summary).toHaveTextContent(/1 opening balance not scored/);
    expect(summary).not.toHaveTextContent('Across 2');
  });

  it('does not read an item with nothing scorable as reconciling', async () => {
    const detail = await openDetail(
      {
        '/api/reconciliation': BASELINE_ONLY_REPORT,
        '/api/items/huila/reconciliation': BASELINE_ONLY,
      },
      'Huila',
    );

    // Its totalVariance is 0, but nothing was ever scored against it.
    expect(detail).not.toHaveTextContent('reconciles');
    expect(detail).toHaveTextContent(/Nothing scored yet/);
    expect(detail).toHaveTextContent('◆ 8 kg opening balance');

    const listRow = screen.getByRole('button', { name: 'Huila' }).closest('tr') as HTMLElement;
    expect(listRow).toHaveTextContent('opening balance');
    expect(listRow).not.toHaveTextContent('reconciles');
    expect(listRow).not.toHaveTextContent('not known');
  });

  it('says plainly when the backend is not answering', async () => {
    const report = within(await openReport({}));
    expect(await report.findByRole('alert')).toHaveTextContent(/is not answering/);
  });

  it('leaves the stock board reachable and untouched', async () => {
    await openReport({ '/api/reconciliation': REPORT });
    await userEvent.click(screen.getByRole('tab', { name: 'Stock board' }));

    expect(screen.getByRole('button', { name: 'Yirgacheffe' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Shrinkage report' })).not.toBeInTheDocument();
  });
});
