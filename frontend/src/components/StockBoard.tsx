import type { StockItem } from '../lib/types.ts';
import { formatTime } from '../lib/time.ts';
import { formatQuantity } from '../lib/units.ts';

/**
 * Below these levels an item gets flagged. The contract does not carry a
 * per-item reorder point yet, so this is a UI-only rule of thumb — roughly a
 * kilo of beans, a litre of milk, a case of cups.
 */
const LOW_STOCK: Record<StockItem['baseUnit'], number> = { g: 1000, ml: 1000, each: 24 };

export function isLow(item: StockItem): boolean {
  return item.quantity < LOW_STOCK[item.baseUnit];
}

interface Props {
  items: StockItem[];
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
}

export function StockBoard({ items, selectedItemId, onSelect }: Props) {
  if (items.length === 0) {
    return (
      <p className="empty">
        The board is blank — no items have been defined yet. Seed the backend, then reload.
      </p>
    );
  }

  return (
    <table className="board">
      <caption className="visually-hidden">Current stock. Select an item to see its history.</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Category</th>
          <th scope="col" className="num">
            On hand
          </th>
          <th scope="col">Last moved</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const low = isLow(item);
          return (
            <tr
              key={item.itemId}
              className={`${low ? 'low' : ''} ${item.itemId === selectedItemId ? 'selected' : ''}`.trim()}
            >
              <th scope="row">
                <button
                  type="button"
                  className="link"
                  onClick={() => onSelect(item.itemId)}
                  aria-current={item.itemId === selectedItemId ? 'true' : undefined}
                >
                  {item.name}
                </button>
              </th>
              <td>{item.category}</td>
              <td className="num">
                {formatQuantity(item.quantity, item.baseUnit)}
                {low && <span className="flag"> low</span>}
              </td>
              <td>{formatTime(item.lastEventAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
