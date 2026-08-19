import { useEffect, useState } from 'react';
import { API_URL, ApiError, UNREACHABLE, getReconciliation } from '../lib/api.ts';
import type { ReconciliationRow } from '../lib/types.ts';
import { formatTime } from '../lib/time.ts';
import { formatVariancePct, readOpeningBalance, readVariance } from '../lib/variance.ts';
import { ReconciliationDetail } from './ReconciliationDetail.tsx';

interface Props {
  /** Bumped by the parent after an append, so the report re-reads the log. */
  reloadKey: number;
}

/**
 * "We bought 12 kg and counted 11.2 — where did it go?"
 *
 * One row per item, worst shrinkage at the top. Selecting a row opens the
 * arithmetic behind that item's number.
 */
export function ShrinkageReport({ reloadKey }: Props) {
  const [rows, setRows] = useState<ReconciliationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    getReconciliation()
      .then((report) => {
        if (live) setRows(report);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.code === UNREACHABLE) {
          setError(`The backend at ${API_URL} is not answering. Is it running?`);
        } else {
          setError(err instanceof ApiError ? err.message : 'Could not load the shrinkage report.');
        }
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  return (
    <section className="report" aria-label="Shrinkage report">
      <h2>Shrinkage — worst first</h2>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error === null && rows === null && <p className="muted">Reconciling the log…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="empty">Nothing to reconcile — no items have been defined yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="board">
          <caption className="visually-hidden">
            Shrinkage by item, worst first. Select an item to see how each count reconciled.
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Category</th>
              <th scope="col">Off by</th>
              <th scope="col" className="num">
                Of expected
              </th>
              <th scope="col">Last counted</th>
              <th scope="col" className="num">
                Counts
              </th>
            </tr>
          </thead>
          <tbody>
            {/* The API ranks these by percentage, most negative first, because
                grams, millilitres and "each" do not compare — that ordering is
                the report's whole point, so it is rendered as delivered, never
                re-sorted. */}
            {rows.map((row) => {
              const counted = row.countsRecorded > 0;
              // Nothing scorable — counted only as an opening balance — comes
              // with a null percentage and a totalVariance of 0. That 0 is not
              // "reconciles"; there was never anything to reconcile against.
              const scored = counted && row.totalVariancePct !== null;
              const reading = scored
                ? readVariance(row.totalVariance, row.baseUnit)
                : readOpeningBalance(null, row.baseUnit);
              return (
                <tr
                  key={row.itemId}
                  className={row.itemId === selectedItemId ? 'selected' : undefined}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="link"
                      onClick={() => setSelectedItemId(row.itemId)}
                      aria-current={row.itemId === selectedItemId ? 'true' : undefined}
                    >
                      {row.name}
                    </button>
                  </th>
                  <td>{row.category}</td>
                  {/* No count yet is an absence of evidence, not a variance of zero. */}
                  <td className={counted ? `variance ${reading.tone}` : 'variance uncounted'}>
                    {counted ? reading.text : 'never counted'}
                  </td>
                  <td className="num">{formatVariancePct(row.totalVariancePct)}</td>
                  <td>{counted ? formatTime(row.lastCountAt) : '—'}</td>
                  <td className="num">{row.countsRecorded}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedItemId !== null && (
        <ReconciliationDetail
          itemId={selectedItemId}
          reloadKey={reloadKey}
          onClose={() => setSelectedItemId(null)}
        />
      )}
    </section>
  );
}
