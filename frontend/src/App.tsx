import { useCallback, useEffect, useState } from 'react';
import { ItemHistory } from './components/ItemHistory.tsx';
import { MovementForm } from './components/MovementForm.tsx';
import { StockBoard } from './components/StockBoard.tsx';
import { API_URL, ApiError, UNREACHABLE, getStock } from './lib/api.ts';
import type { StockItem } from './lib/types.ts';

export function App() {
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await getStock());
    } catch (err: unknown) {
      setItems(null);
      if (err instanceof ApiError && err.code === UNREACHABLE) {
        setError(`The backend at ${API_URL} is not answering. Is it running?`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load the stock board.');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  const selected = items?.find((item) => item.itemId === selectedItemId) ?? null;

  return (
    <main className="app">
      <header className="masthead">
        <h1>bean counter</h1>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </header>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error === null && items === null && <p className="muted">Reading the board…</p>}
      {items !== null && (
        <StockBoard items={items} selectedItemId={selectedItemId} onSelect={setSelectedItemId} />
      )}

      {selected !== null && (
        <ItemHistory
          item={selected}
          reloadKey={reloadKey}
          onClose={() => setSelectedItemId(null)}
        />
      )}

      <div className="forms">
        <MovementForm kind="receive" items={items ?? []} onRecorded={refresh} />
        <MovementForm kind="waste" items={items ?? []} onRecorded={refresh} />
      </div>
    </main>
  );
}
