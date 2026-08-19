/**
 * How a variance reads on the screen.
 *
 * The number itself is formatted by `units.ts` — the single conversion path in
 * this frontend. What lives here is the *reading*: which side of zero the
 * variance falls on and the shop word for it.
 *
 * The sign carries the meaning (docs/architecture/slice-2-reconciliation-contract.md):
 * negative is shrinkage — stock the log predicted that the shelf did not have.
 * Positive is overage, which is not good news: it almost always means a
 * delivery was never written down. So neither side is ever shown as a bare
 * magnitude, and colour is never the only cue — every reading carries an arrow
 * and a word too.
 */
import type { BaseUnit } from './units.ts';
import { formatQuantity } from './units.ts';

export type VarianceTone = 'short' | 'over' | 'level' | 'unknown' | 'baseline';

export interface VarianceReading {
  readonly tone: VarianceTone;
  /** A cue that survives greyscale: down for short, up for over, ◆ for a baseline. */
  readonly arrow: string;
  /** The signed amount in the item's own units, e.g. `-250 g` or `+1.5 kg`. */
  readonly amount: string;
  /** The shop word for it, e.g. `short`. */
  readonly label: string;
  /** Arrow, amount and word as one string — what a cell renders. */
  readonly text: string;
}

const WORDS: Readonly<Record<VarianceTone, { readonly arrow: string; readonly label: string }>> = {
  short: { arrow: '▼', label: 'short' },
  over: { arrow: '▲', label: 'over — delivery not recorded?' },
  level: { arrow: '=', label: 'reconciles' },
  unknown: { arrow: '', label: 'not known' },
  baseline: { arrow: '◆', label: 'opening balance' },
};

/**
 * Read a signed base-unit variance for humans.
 *
 * A zero variance is a real, good outcome, so it reads "reconciles" rather
 * than an empty cell. A variance that is neither null nor a finite number
 * should not be possible — the API sends integers — but it is reported as
 * unknown rather than silently sorted onto one side of zero.
 *
 * `null` here is the same defensive case: the API sends it only on an opening
 * balance, and an opening balance is read by `readOpeningBalance` instead. A
 * null reaching this function means a *scored* count arrived without a
 * variance, which really is not known — never a baseline, never a zero.
 */
export function readVariance(variance: number | null, baseUnit: BaseUnit): VarianceReading {
  const tone: VarianceTone =
    variance === null || !Number.isFinite(variance)
      ? 'unknown'
      : variance < 0
        ? 'short'
        : variance > 0
          ? 'over'
          : 'level';

  // "= 0 g reconciles" says nothing that "reconciles" does not, and an unknown
  // variance has no amount worth printing.
  const amount =
    variance !== null && (tone === 'short' || tone === 'over')
      ? `${variance > 0 ? '+' : ''}${formatQuantity(variance, baseUnit)}`
      : '';

  return reading(tone, amount);
}

/**
 * Read an opening balance — the shop's starting count.
 *
 * Nothing preceded it in the log, so there was no prediction to be wrong
 * about: this is not a variance of zero, and it is not a variance the UI
 * failed to understand. The information in such a row is the quantity that was
 * on the shelf to begin with ("we started with 12 kg"), so that is what it
 * shows, unsigned, next to the word for what it is.
 *
 * `countedQuantity` is null where there is no single quantity to show — a
 * whole-shop row whose every count was an opening balance — and the reading is
 * then just the word.
 */
export function readOpeningBalance(
  countedQuantity: number | null,
  baseUnit: BaseUnit,
): VarianceReading {
  const amount = countedQuantity === null ? '' : formatQuantity(countedQuantity, baseUnit);
  return reading('baseline', amount);
}

function reading(tone: VarianceTone, amount: string): VarianceReading {
  const words = WORDS[tone];
  const text = [words.arrow, amount, words.label].filter((part) => part !== '').join(' ');
  return { tone, arrow: words.arrow, amount, label: words.label, text };
}

/**
 * Render a variance percentage.
 *
 * `null` means the log expected nothing at the moment of the count, so there
 * is no denominator. The contract is explicit that this is not zero, so it
 * renders as a dash — never `null`, `NaN`, `Infinity` or a fabricated `0%`.
 */
export function formatVariancePct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const rounded = Number(pct.toFixed(1)); // -1.55 -> -1.6, and 2.0 -> 2
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}
