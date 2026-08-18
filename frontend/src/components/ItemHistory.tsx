import { useEffect, useState } from 'react';
import { ApiError, getHistory } from '../lib/api.ts';
import type { HistoryEntry, StockItem } from '../lib/types.ts';
import { formatTime } from '../lib/time.ts';
import { formatQuantity } from '../lib/units.ts';

/** The quantity an event moved, if it carries one, already in base units. */
function eventQuantity(entry: HistoryEntry): number | null {
  const raw = entry.payload['quantity'] ?? entry.payload['countedQuantity'];
  return typeof raw === 'number' ? raw : null;
}

/** `StockDepleted` -> `-`, `StockReceived` -> `+`, a count is neither. */
function sign(entry: HistoryEntry): string {
  if (entry.eventType === 'StockReceived') return '+';
  if (entry.eventType === 'StockDepleted') return '−';
  return '';
}

function detail(entry: HistoryEntry): string | null {
  const parts: string[] = [];
  for (const key of ['reason', 'supplier', 'lotId'] as const) {
    const value = entry.payload[key];
    if (typeof value === 'string' && value !== '') parts.push(value);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface Props {
  item: StockItem;
  /** Bumped by the parent after an append, so the ledger re-reads the log. */
  reloadKey: number;
  onClose: () => void;
}

/** The spike of order tickets: every event for one item, newest first. */
export function ItemHistory({ item, reloadKey, onClose }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setError(null);
    getHistory(item.itemId)
      .then((rows) => {
        if (live) setEntries(rows);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof ApiError ? err.message : 'Could not load this history.');
      });
    return () => {
      live = false;
    };
  }, [item.itemId, reloadKey]);

  const newestFirst = entries === null ? [] : [...entries].sort((a, b) => b.sequence - a.sequence);

  return (
    <section className="history" aria-label={`History for ${item.name}`}>
      <header>
        <h2>{item.name} — history</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {error !== null && <p className="error">{error}</p>}
      {error === null && entries === null && <p className="muted">Reading the log…</p>}
      {error === null && entries !== null && entries.length === 0 && (
        <p className="muted">No events recorded for this item yet.</p>
      )}

      {newestFirst.length > 0 && (
        <ol className="ledger">
          {newestFirst.map((entry) => {
            const quantity = eventQuantity(entry);
            const note = detail(entry);
            return (
              <li key={entry.sequence}>
                <span className="ticket-type">{entry.eventType}</span>
                <span className="ticket-qty">
                  {quantity === null ? '' : `${sign(entry)}${formatQuantity(quantity, item.baseUnit)}`}
                </span>
                <span className="ticket-when">{formatTime(entry.occurredAt)}</span>
                {note !== null && <span className="ticket-note">{note}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
