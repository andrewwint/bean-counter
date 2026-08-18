import { describe, expect, it } from 'vitest';
import { INPUT_UNITS, formatQuantity, parseQuantity } from './units.ts';

describe('formatQuantity', () => {
  it('renders grams as kilograms once they reach 1000', () => {
    expect(formatQuantity(12000, 'g')).toBe('12 kg');
    expect(formatQuantity(1000, 'g')).toBe('1 kg');
    expect(formatQuantity(999, 'g')).toBe('999 g');
    expect(formatQuantity(0, 'g')).toBe('0 g');
  });

  it('renders millilitres as litres once they reach 1000', () => {
    expect(formatQuantity(4000, 'ml')).toBe('4 L');
    expect(formatQuantity(250, 'ml')).toBe('250 ml');
  });

  it('renders each as-is, with no unit suffix', () => {
    expect(formatQuantity(12, 'each')).toBe('12');
    expect(formatQuantity(2400, 'each')).toBe('2,400');
  });

  it('converts exactly rather than rounding away base units', () => {
    expect(formatQuantity(12345, 'g')).toBe('12.345 kg');
    expect(formatQuantity(1500, 'ml')).toBe('1.5 L');
    expect(formatQuantity(1050, 'g')).toBe('1.05 kg');
    expect(formatQuantity(1005, 'g')).toBe('1.005 kg');
  });

  it('keeps the seeded, deliberately non-round values intact', () => {
    // The dev seed avoids clean multiples of 1000 precisely to expose rounding.
    expect(formatQuantity(15850, 'g')).toBe('15.85 kg');
    expect(formatQuantity(11250, 'g')).toBe('11.25 kg');
    expect(formatQuantity(4100, 'g')).toBe('4.1 kg');
    expect(formatQuantity(20500, 'ml')).toBe('20.5 L');
    expect(formatQuantity(12900, 'ml')).toBe('12.9 L');
    expect(formatQuantity(1610, 'each')).toBe('1,610');
    expect(formatQuantity(657, 'each')).toBe('657');
  });

  it('groups thousands in the large unit', () => {
    expect(formatQuantity(1234000, 'g')).toBe('1,234 kg');
  });

  it('handles a negative quantity without mangling it', () => {
    expect(formatQuantity(-1500, 'g')).toBe('-1.5 kg');
    expect(formatQuantity(-200, 'ml')).toBe('-200 ml');
  });

  it('does not pretend to know a non-finite quantity', () => {
    expect(formatQuantity(Number.NaN, 'g')).toBe('—');
  });
});

describe('parseQuantity', () => {
  it('converts a whole large unit to base units', () => {
    expect(parseQuantity('12', 'kg', 'g')).toEqual({ ok: true, quantity: 12000 });
    expect(parseQuantity('4', 'L', 'ml')).toEqual({ ok: true, quantity: 4000 });
  });

  it('passes base units straight through', () => {
    expect(parseQuantity('750', 'g', 'g')).toEqual({ ok: true, quantity: 750 });
    expect(parseQuantity('12', 'each', 'each')).toEqual({ ok: true, quantity: 12 });
  });

  it('accepts fractions that land exactly on a base unit', () => {
    expect(parseQuantity('1.5', 'kg', 'g')).toEqual({ ok: true, quantity: 1500 });
    expect(parseQuantity('0.5', 'L', 'ml')).toEqual({ ok: true, quantity: 500 });
    expect(parseQuantity('.25', 'kg', 'g')).toEqual({ ok: true, quantity: 250 });
    expect(parseQuantity('12.345', 'kg', 'g')).toEqual({ ok: true, quantity: 12345 });
  });

  it('avoids binary float error on the multiply', () => {
    // 1.1 * 1000 is 1100.0000000000002 in IEEE 754.
    expect(parseQuantity('1.1', 'kg', 'g')).toEqual({ ok: true, quantity: 1100 });
    expect(parseQuantity('0.07', 'L', 'ml')).toEqual({ ok: true, quantity: 70 });
  });

  it('rejects a fraction of an each rather than rounding it', () => {
    const result = parseQuantity('0.5', 'each', 'each');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/whole number of each/);
  });

  it('rejects precision finer than one base unit', () => {
    expect(parseQuantity('0.0001', 'kg', 'g').ok).toBe(false);
    expect(parseQuantity('1.5', 'g', 'g').ok).toBe(false);
    expect(parseQuantity('0.5', 'ml', 'ml').ok).toBe(false);
  });

  it('rejects zero, negatives and non-numbers', () => {
    expect(parseQuantity('0', 'kg', 'g').ok).toBe(false);
    expect(parseQuantity('-3', 'kg', 'g').ok).toBe(false);
    expect(parseQuantity('twelve', 'kg', 'g').ok).toBe(false);
    expect(parseQuantity('', 'kg', 'g').ok).toBe(false);
    expect(parseQuantity('   ', 'kg', 'g').ok).toBe(false);
  });

  it('rejects a unit that does not belong to the base unit', () => {
    expect(parseQuantity('1', 'kg', 'ml').ok).toBe(false);
    expect(parseQuantity('1', 'L', 'each').ok).toBe(false);
  });

  it('round-trips every offered unit back through the formatter', () => {
    const cases = [
      { base: 'g', text: '2.5', unit: 'kg', formatted: '2.5 kg' },
      { base: 'ml', text: '1.75', unit: 'L', formatted: '1.75 L' },
      { base: 'each', text: '48', unit: 'each', formatted: '48' },
    ] as const;

    for (const c of cases) {
      const parsed = parseQuantity(c.text, c.unit, c.base);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Number.isInteger(parsed.quantity)).toBe(true);
        expect(formatQuantity(parsed.quantity, c.base)).toBe(c.formatted);
      }
    }
  });

  it('offers only the units that belong to each base unit', () => {
    expect(INPUT_UNITS.g.map((u) => u.label)).toEqual(['g', 'kg']);
    expect(INPUT_UNITS.ml.map((u) => u.label)).toEqual(['ml', 'L']);
    expect(INPUT_UNITS.each.map((u) => u.label)).toEqual(['each']);
  });
});
