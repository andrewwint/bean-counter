import { useEffect, useState } from 'react';
import { ApiError, getItemReconciliation } from '../lib/api.ts';
import type { ItemReconciliation } from '../lib/types.ts';
import { formatTime } from '../lib/time.ts';
import { formatQuantity } from '../lib/units.ts';
import { formatVariancePct, readOpeningBalance, readVariance } from '../lib/variance.ts';

interface Props {
  itemId: string;
  /** Bumped by the parent after an append, so the detail re-reads the log. */
  reloadKey: number;
  onClose: () => void;
}

/**
 * The arithmetic behind one item's shrinkage: for every count, what the log
 * expected, what was actually on the shelf, and the difference. Showing the
 * two operands is the point — a bare verdict is not something a shop owner can
 * argue with or act on.
 */
export function ReconciliationDetail({ itemId, reloadKey, onClose }: Props) {
  const [report, setReport] = useState<ItemReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    getItemReconciliation(itemId)
      .then((rows) => {
        if (live) setReport(rows);
      })
      .catch((err: unknown) => {
        if (live) {
          setError(err instanceof ApiError ? err.message : 'Could not load this reconciliation.');
        }
      });
    return () => {
      live = false;
    };
  }, [itemId, reloadKey]);

  const total = report === null ? null : readVariance(report.totalVariance, report.baseUnit);
  // `totalVariance` is across the scored counts only, so the sentence above the
  // table counts the same rows the total does — otherwise an opening balance
  // reads as a count that contributed 0.
  const scored = report?.counts.filter((count) => !count.isOpeningBalance).length ?? 0;
  const opening = (report?.counts.length ?? 0) - scored;

  return (
    <section className="history" aria-label={`Reconciliation for ${report?.name ?? itemId}`}>
      <header>
        <h2>{report?.name ?? itemId} — counts vs the log</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error === null && report === null && <p className="muted">Reconciling…</p>}

      {report !== null && report.counts.length === 0 && (
        <p className="muted">Never counted — there is nothing to reconcile yet.</p>
      )}

      {report !== null && total !== null && report.counts.length > 0 && (
        <>
          <p className={`variance ${scored === 0 ? 'baseline' : total.tone}`}>
            {scored === 0
              ? 'Nothing scored yet — every count so far is an opening balance.'
              : `Across ${scored} scored ${scored === 1 ? 'count' : 'counts'}: ${total.text}`}
            {opening > 0 && (
              <span className="muted">
                {' '}
                ({opening} opening {opening === 1 ? 'balance' : 'balances'} not scored)
              </span>
            )}
          </p>

          <table className="board">
            <caption className="visually-hidden">
              Every count of {report.name}, oldest first, with what the log expected.
            </caption>
            <thead>
              <tr>
                <th scope="col">Counted on</th>
                <th scope="col" className="num">
                  Log expected
                </th>
                <th scope="col" className="num">
                  Counted
                </th>
                <th scope="col">Difference</th>
                <th scope="col" className="num">
                  Of expected
                </th>
              </tr>
            </thead>
            <tbody>
              {report.counts.map((count) => {
                // `isOpeningBalance` is the discriminator, not a null variance
                // and not an expected quantity of 0 — a count of an item that
                // really was expected to be empty is a variance, and a bad one.
                const reading = count.isOpeningBalance
                  ? readOpeningBalance(count.countedQuantity, report.baseUnit)
                  : readVariance(count.variance, report.baseUnit);
                return (
                  <tr
                    key={count.sequence}
                    className={count.isOpeningBalance ? 'baseline' : undefined}
                  >
                    <th scope="row">{formatTime(count.occurredAt)}</th>
                    {/* The log predicted nothing before an opening balance; a
                        "0" here would read as a prediction that it was empty. */}
                    <td className="num">
                      {count.isOpeningBalance
                        ? '—'
                        : formatQuantity(count.expectedQuantity, report.baseUnit)}
                    </td>
                    <td className="num">{formatQuantity(count.countedQuantity, report.baseUnit)}</td>
                    <td className={`variance ${reading.tone}`}>{reading.text}</td>
                    <td className="num">{formatVariancePct(count.variancePct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {report !== null && (
        <p className="muted since">
          Since the last count: {formatQuantity(report.sinceLastCount.received, report.baseUnit)} in,{' '}
          {formatQuantity(report.sinceLastCount.depleted.sale, report.baseUnit)} sold,{' '}
          {formatQuantity(report.sinceLastCount.depleted.waste, report.baseUnit)} wasted,{' '}
          {formatQuantity(report.sinceLastCount.depleted.sample, report.baseUnit)} sampled — the log
          expects {formatQuantity(report.sinceLastCount.expectedQuantity, report.baseUnit)} on the
          shelf now.
        </p>
      )}
    </section>
  );
}
