/** Typed `fetch` wrapper for the bean-counter API. Base units in, base units out. */
import type {
  AppendResult,
  AppendedEvent,
  HistoryEntry,
  ItemReconciliation,
  NewEvent,
  ReconciliationRow,
  StockItem,
} from './types.ts';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** An API call that failed. `code` is the backend's error code when it gave one. */
export class ApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** The backend is not answering at all — almost always "it isn't running yet". */
export const UNREACHABLE = 'unreachable';

/** The backend's error code for an `eventId` reused for a different fact. */
export const EVENT_ID_CONFLICT = 'EVENT_ID_CONFLICT';

/**
 * A successful response, body and status. The status is carried because
 * `POST /api/events` says "appended" with 201 and "you already sent me this
 * one" with 200, and the bodies are byte-identical — only the code tells them
 * apart.
 */
interface ApiResponse<T> {
  status: number;
  data: T;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new ApiError(`Could not reach the backend at ${API_URL}.`, UNREACHABLE);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      body?.error?.message ?? `Request to ${path} failed (${response.status}).`,
      body?.error?.code ?? String(response.status),
    );
  }

  return { status: response.status, data: (await response.json()) as T };
}

export async function getStock(): Promise<StockItem[]> {
  return (await request<StockItem[]>('/api/stock')).data;
}

export async function getHistory(itemId: string): Promise<HistoryEntry[]> {
  return (await request<HistoryEntry[]>(`/api/items/${encodeURIComponent(itemId)}/history`)).data;
}

/** The shop-wide shrinkage report, already ordered worst-first by the API. */
export async function getReconciliation(): Promise<ReconciliationRow[]> {
  return (await request<ReconciliationRow[]>('/api/reconciliation')).data;
}

/** One item's count history with the arithmetic behind each variance. */
export async function getItemReconciliation(itemId: string): Promise<ItemReconciliation> {
  const path = `/api/items/${encodeURIComponent(itemId)}/reconciliation`;
  return (await request<ItemReconciliation>(path)).data;
}

/**
 * Append an event. `quantity` must already be an integer in the item's base
 * unit.
 *
 * `eventId` is the idempotency handle: send the *same* one for every retry of
 * the same submission and the log records it once, however many times the
 * button is pressed. A replay comes back 200 with the original write, which is
 * a success (`replayed: true`), not an error. Reusing a handle for a different
 * fact is an `EVENT_ID_CONFLICT` — a client bug, and it throws.
 */
export async function postEvent(event: NewEvent, eventId: string): Promise<AppendResult> {
  const { status, data } = await request<AppendedEvent>('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...event, eventId }),
  });
  return { ...data, replayed: status === 200 };
}
