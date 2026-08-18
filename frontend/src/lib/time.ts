/** Timestamp rendering for the board and the ledger. */

/** `2026-08-18T14:05:00Z` -> `Aug 18, 2:05 PM` in the reader's own timezone. */
export function formatTime(iso: string | null): string {
  if (iso === null) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
