import { describe, expect, it } from 'vitest';
import { formatVariancePct, readOpeningBalance, readVariance } from './variance.ts';

describe('readVariance', () => {
  it('reads a negative variance as shrinkage, with the sign kept', () => {
    const reading = readVariance(-250, 'g');
    expect(reading.tone).toBe('short');
    expect(reading.amount).toBe('-250 g');
    expect(reading.text).toBe('▼ -250 g short');
  });

  it('reads a positive variance as an overage, not as good news', () => {
    const reading = readVariance(4000, 'ml');
    expect(reading.tone).toBe('over');
    expect(reading.amount).toBe('+4 L');
    expect(reading.label).toMatch(/delivery not recorded/);
    expect(reading.text).toBe('▲ +4 L over — delivery not recorded?');
  });

  it('reads a zero variance as reconciling, not as an empty cell', () => {
    const reading = readVariance(0, 'g');
    expect(reading.tone).toBe('level');
    expect(reading.text).toBe('= reconciles');
    expect(reading.text).not.toBe('');
  });

  it('converts through the one unit formatter rather than a second path', () => {
    // Same conversions units.test.ts pins for the board: exact, never rounded.
    expect(readVariance(-1500, 'g').amount).toBe('-1.5 kg');
    expect(readVariance(-12345, 'g').amount).toBe('-12.345 kg');
    expect(readVariance(1050, 'ml').amount).toBe('+1.05 L');
    expect(readVariance(-8, 'each').amount).toBe('-8');
  });

  it('carries a non-colour cue on every reading', () => {
    expect(readVariance(-250, 'g').arrow).toBe('▼');
    expect(readVariance(250, 'g').arrow).toBe('▲');
    expect(readVariance(0, 'g').arrow).toBe('=');
  });

  it('does not sort a non-finite variance onto one side of zero', () => {
    const reading = readVariance(Number.NaN, 'g');
    expect(reading.tone).toBe('unknown');
    expect(reading.text).toBe('not known');
    expect(reading.text).not.toMatch(/NaN/);
  });

  it('keeps a null variance on a scored count as the anomaly it would be', () => {
    // The API sends null only on an opening balance, which is read elsewhere.
    // Reaching here means a scored count arrived without one: not a baseline,
    // not a zero — genuinely unknown, and the defensive branch stays defensive.
    const reading = readVariance(null, 'g');
    expect(reading.tone).toBe('unknown');
    expect(reading.text).toBe('not known');
    expect(reading.text).not.toMatch(/null/);
  });
});

describe('readOpeningBalance', () => {
  it('reads a starting count as a baseline, not as an unknown', () => {
    const reading = readOpeningBalance(12000, 'g');
    expect(reading.tone).toBe('baseline');
    expect(reading.tone).not.toBe('unknown');
    expect(reading.label).toBe('opening balance');
    expect(reading.text).not.toMatch(/not known/);
  });

  it('shows the quantity the shop started with — the real information in the row', () => {
    expect(readOpeningBalance(12000, 'g').text).toBe('◆ 12 kg opening balance');
    // Unsigned: there is no prediction for it to be above or below.
    expect(readOpeningBalance(12000, 'g').amount).not.toMatch(/[+-]/);
    // Through the one unit formatter, like every other quantity on the screen.
    expect(readOpeningBalance(1050, 'ml').amount).toBe('1.05 L');
    expect(readOpeningBalance(8, 'each').amount).toBe('8');
  });

  it('carries a non-colour cue, and one that is not a variance arrow', () => {
    const reading = readOpeningBalance(500, 'g');
    expect(reading.arrow).toBe('◆');
    expect(reading.arrow).not.toBe(readVariance(-1, 'g').arrow);
    expect(reading.arrow).not.toBe(readVariance(1, 'g').arrow);
    expect(reading.arrow).not.toBe(readVariance(0, 'g').arrow);
  });

  it('is just the word when there is no single quantity to show', () => {
    const reading = readOpeningBalance(null, 'g');
    expect(reading.tone).toBe('baseline');
    expect(reading.amount).toBe('');
    expect(reading.text).toBe('◆ opening balance');
  });
});

describe('formatVariancePct', () => {
  it('renders a null percentage as a dash — there is no denominator', () => {
    expect(formatVariancePct(null)).toBe('—');
  });

  it('never leaks a JS value for a percentage it cannot state', () => {
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatVariancePct(value)).toBe('—');
    }
  });

  it('keeps the sign on a real percentage', () => {
    expect(formatVariancePct(-1.55)).toBe('-1.6%');
    expect(formatVariancePct(12.5)).toBe('+12.5%');
    expect(formatVariancePct(2)).toBe('+2%');
  });

  it('renders an exact zero as 0%', () => {
    expect(formatVariancePct(0)).toBe('0%');
    // -0 is still zero; it must not print as "-0%".
    expect(formatVariancePct(-0.04)).toBe('0%');
  });
});
