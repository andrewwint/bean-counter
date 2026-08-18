import { useState } from 'react';
import { ApiError, postEvent } from '../lib/api.ts';
import type { NewEvent, StockItem } from '../lib/types.ts';
import { INPUT_UNITS, parseQuantity } from '../lib/units.ts';

type Kind = 'receive' | 'waste';

interface Props {
  kind: Kind;
  items: StockItem[];
  /** Called after a successful append, so the board and ledger re-read. */
  onRecorded: () => void;
}

const COPY: Record<Kind, { title: string; submit: string; done: string }> = {
  receive: { title: 'Receive stock', submit: 'Record delivery', done: 'Delivery recorded.' },
  waste: { title: 'Record waste', submit: 'Record waste', done: 'Waste recorded.' },
};

/**
 * Receive-stock and record-waste share every field but the supplier, so they
 * share a form. The quantity leaves here as an integer in the item's base unit
 * — `parseQuantity` is the only thing that converts.
 */
export function MovementForm({ kind, items, onRecorded }: Props) {
  const [itemId, setItemId] = useState('');
  const [amount, setAmount] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [supplier, setSupplier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const item = items.find((candidate) => candidate.itemId === itemId) ?? null;
  const units = item === null ? [] : INPUT_UNITS[item.baseUnit];
  const selectedUnit = units.find((u) => u.label === unitLabel)?.label ?? units[0]?.label ?? '';

  function selectItem(nextItemId: string) {
    setItemId(nextItemId);
    setUnitLabel(''); // fall back to the new item's own base unit
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);

    if (item === null) {
      setError('Pick an item.');
      return;
    }

    const parsed = parseQuantity(amount, selectedUnit, item.baseUnit);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    const body: NewEvent =
      kind === 'receive'
        ? {
            type: 'StockReceived',
            itemId: item.itemId,
            quantity: parsed.quantity,
            ...(supplier.trim() === '' ? {} : { supplier: supplier.trim() }),
          }
        : { type: 'StockDepleted', itemId: item.itemId, quantity: parsed.quantity, reason: 'waste' };

    setBusy(true);
    setError(null);
    try {
      await postEvent(body);
      setAmount('');
      setSupplier('');
      setNotice(COPY[kind].done);
      onRecorded();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not record that event.');
    } finally {
      setBusy(false);
    }
  }

  const fieldId = `${kind}-`;

  return (
    <form className="movement" aria-label={COPY[kind].title} onSubmit={submit}>
      <h2>{COPY[kind].title}</h2>

      <label htmlFor={`${fieldId}item`}>Item</label>
      <select
        id={`${fieldId}item`}
        value={itemId}
        onChange={(e) => selectItem(e.target.value)}
        disabled={items.length === 0}
      >
        <option value="">Choose an item…</option>
        {items.map((candidate) => (
          <option key={candidate.itemId} value={candidate.itemId}>
            {candidate.name}
          </option>
        ))}
      </select>

      <label htmlFor={`${fieldId}amount`}>Quantity</label>
      <div className="quantity">
        <input
          id={`${fieldId}amount`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="12"
        />
        <select
          aria-label="Unit"
          value={selectedUnit}
          onChange={(e) => setUnitLabel(e.target.value)}
          disabled={item === null}
        >
          {units.map((unit) => (
            <option key={unit.label} value={unit.label}>
              {unit.label}
            </option>
          ))}
        </select>
      </div>

      {kind === 'receive' && (
        <>
          <label htmlFor={`${fieldId}supplier`}>Supplier (optional)</label>
          <input
            id={`${fieldId}supplier`}
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </>
      )}

      <button type="submit" disabled={busy || items.length === 0}>
        {busy ? 'Recording…' : COPY[kind].submit}
      </button>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <p className="notice">{notice}</p>}
    </form>
  );
}
