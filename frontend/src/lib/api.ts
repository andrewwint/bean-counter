/** Typed `fetch` wrapper for the bean-counter API. Base units in, base units out. */
import type { AppendedEvent, HistoryEntry, NewEvent, StockItem } from './types.ts';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

  return (await response.json()) as T;
}

export function getStock(): Promise<StockItem[]> {
  return request<StockItem[]>('/api/stock');
}

export function getHistory(itemId: string): Promise<HistoryEntry[]> {
  return request<HistoryEntry[]>(`/api/items/${encodeURIComponent(itemId)}/history`);
}

/** Append an event. `quantity` must already be an integer in the item's base unit. */
export function postEvent(event: NewEvent): Promise<AppendedEvent> {
  return request<AppendedEvent>('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}
