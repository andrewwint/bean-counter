/**
 * The unit boundary.
 *
 * The API speaks base units only: integers in `g`, `ml` or `each` (see
 * docs/architecture/slice-1-contract.md). Nothing else in the frontend may
 * convert quantities — formatting happens here, on the way to the screen, and
 * parsing happens here, on the way to a POST body. Component state always
 * holds the base-unit integer.
 */

export type BaseUnit = 'g' | 'ml' | 'each';

/** A unit the user may type or pick in a form, and its size in base units. */
export interface InputUnit {
  /** Label shown in the picker, e.g. `kg`. */
  readonly label: string;
  /** How many base units one of these is worth, e.g. 1000 for kg. */
  readonly perBase: number;
}

/** The units offered for each base unit, largest last. */
export const INPUT_UNITS: Readonly<Record<BaseUnit, readonly InputUnit[]>> = {
  g: [
    { label: 'g', perBase: 1 },
    { label: 'kg', perBase: 1000 },
  ],
  ml: [
    { label: 'ml', perBase: 1 },
    { label: 'L', perBase: 1000 },
  ],
  each: [{ label: 'each', perBase: 1 }],
};

/**
 * Render a base-unit integer for humans.
 *
 * `12000` g -> `12 kg`, `4000` ml -> `4 L`, `each` renders as-is. The
 * conversion is exact: 12345 g is `12.345 kg`, never a rounded `12.35 kg`,
 * because a stock board that quietly loses grams is how counts drift.
 */
export function formatQuantity(quantity: number, baseUnit: BaseUnit): string {
  if (!Number.isFinite(quantity)) return '—';

  if (baseUnit === 'each') return `${groupDigits(quantity)}`;

  const large = baseUnit === 'g' ? 'kg' : 'L';
  if (Math.abs(quantity) < 1000) return `${groupDigits(quantity)} ${baseUnit}`;

  return `${shiftDown3(quantity)} ${large}`;
}

/** The result of reading a quantity out of a form field. */
export type ParseResult =
  | { readonly ok: true; readonly quantity: number }
  | { readonly ok: false; readonly error: string };

/**
 * Convert what the user typed into a base-unit integer, or explain why it
 * cannot be one.
 *
 * Zero is rejected because this parses *movement* quantities (received,
 * depleted), which the contract requires to be > 0. An absolute
 * `StockCounted.countedQuantity` of 0 is legal and would need its own path.
 *
 * Fractional input is only accepted when it lands exactly on a base unit:
 * `1.5 kg` is 1500 g, but `0.5 each` and `0.0001 kg` are rejected rather than
 * rounded. Rounding here would silently invent or destroy stock, and the event
 * log is append-only — there is no taking it back.
 */
export function parseQuantity(input: string, unitLabel: string, baseUnit: BaseUnit): ParseResult {
  const unit = INPUT_UNITS[baseUnit].find((u) => u.label === unitLabel);
  if (!unit) return { ok: false, error: `Unknown unit "${unitLabel}" for ${baseUnit}.` };

  const text = input.trim();
  if (text === '') return { ok: false, error: 'Enter a quantity.' };

  const typed = Number(text);
  if (!Number.isFinite(typed)) return { ok: false, error: `"${input}" is not a number.` };
  if (typed <= 0) return { ok: false, error: 'Quantity must be greater than zero.' };

  // Multiply in integer space: 1.5 * 1000 is 1500.0000000000002 in floats.
  const quantity = shiftUp(text, unit.perBase);
  if (quantity === null || !Number.isSafeInteger(quantity)) {
    return {
      ok: false,
      error:
        unit.perBase === 1
          ? `Quantity must be a whole number of ${unit.label}.`
          : `${text} ${unit.label} is not a whole number of ${baseUnit}.`,
    };
  }

  return { ok: true, quantity };
}

/** Multiply a decimal string by a power-of-ten factor without float error. */
function shiftUp(text: string, perBase: number): number | null {
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null; // exponent form etc. — not worth guessing at
  const whole = match[1] ?? '';
  const frac = match[2] ?? '';

  const zeros = String(perBase).length - 1; // 1 -> 0, 1000 -> 3
  if (frac.length > zeros) return null; // more precision than a base unit holds

  const digits = `${whole}${frac.padEnd(zeros, '0')}`.replace(/^0+(?=\d)/, '');
  return digits === '' ? null : Number(digits);
}

/** Divide an integer by 1000 exactly, trimming trailing zeros: 12000 -> "12". */
function shiftDown3(value: number): string {
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(4, '0');
  const whole = digits.slice(0, -3);
  const frac = digits.slice(-3).replace(/0+$/, '');
  return `${sign}${groupDigits(Number(whole))}${frac === '' ? '' : `.${frac}`}`;
}

function groupDigits(value: number): string {
  return value.toLocaleString('en-US');
}
