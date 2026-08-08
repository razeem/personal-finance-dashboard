import { calculateEmi } from './emi.model';
import {
  balanceCurve,
  compareStrategies,
  forecast,
  LoanPosition,
  MAX_MONTHS,
  PrepaymentStrategy,
} from './prepayment.model';

const FROM = '2026-04';

/**
 * ₹30,00,000 at 9% over 20 years. `calculateEmi` says the instalment is
 * ₹26,991.78, so running the forecast from the full principal must reproduce
 * that schedule exactly — this is the known-answer tie between the two models.
 */
const REFERENCE = calculateEmi({ principal: 3_000_000, annualRatePct: 9, tenureMonths: 240 });
const HOME: LoanPosition = { principal: 3_000_000, annualRatePct: 9, emi: REFERENCE.emi };

const BASELINE: PrepaymentStrategy = { kind: 'baseline' };

describe('forecast · agreement with the amortization core', () => {
  it('reproduces calculateEmi’s tenure from the same starting position', () => {
    const result = forecast(HOME, BASELINE, FROM);
    expect(REFERENCE.emi).toBeCloseTo(26_991.78, 2);
    expect(result.months).toBe(240);
    expect(result.neverPaysOff).toBe(false);
  });

  it('reproduces its total interest to within rounding', () => {
    const result = forecast(HOME, BASELINE, FROM);
    expect(result.totalInterest).toBeCloseTo(REFERENCE.totalInterest, 0);
  });

  it('matches the balance month by month', () => {
    const result = forecast(HOME, BASELINE, FROM);
    for (const month of [1, 12, 60, 120, 239]) {
      expect(result.schedule[month - 1].balance).toBeCloseTo(
        REFERENCE.schedule[month - 1].balance,
        0,
      );
    }
  });

  it('finishes at exactly zero, not a rounding crumb', () => {
    const result = forecast(HOME, BASELINE, FROM);
    expect(result.schedule[result.schedule.length - 1].balance).toBe(0);
  });

  it('never collects more than the loan is worth in the final month', () => {
    const result = forecast(HOME, BASELINE, FROM);
    const last = result.schedule[result.schedule.length - 1];
    expect(last.emi).toBeLessThanOrEqual(HOME.emi);
  });
});

describe('forecast · dates', () => {
  it('counts the debt-free month from the month given, not the clock', () => {
    // 240 months starting April 2026: month 1 is 2026-04, month 240 is 2046-03.
    expect(forecast(HOME, BASELINE, '2026-04').debtFreeMonth).toBe('2046-03');
  });

  it('is one month long when a single instalment clears the balance', () => {
    const result = forecast(
      { principal: 1_000, annualRatePct: 0, emi: 5_000 },
      BASELINE,
      '2026-04',
    );
    expect(result.months).toBe(1);
    expect(result.debtFreeMonth).toBe('2026-04');
  });
});

describe('forecast · degenerate loans', () => {
  it('returns nothing for a cleared balance', () => {
    expect(forecast({ ...HOME, principal: 0 }, BASELINE, FROM).months).toBe(0);
  });

  it('returns nothing when there is no instalment to pay', () => {
    expect(forecast({ ...HOME, emi: 0 }, BASELINE, FROM).schedule).toEqual([]);
  });

  it('flags a loan whose instalment never covers the interest', () => {
    // ₹10L at 12% accrues ₹10,000/month; a ₹5,000 instalment never touches it.
    const result = forecast(
      { principal: 1_000_000, annualRatePct: 12, emi: 5_000 },
      BASELINE,
      FROM,
    );
    expect(result.neverPaysOff).toBe(true);
    expect(result.months).toBeLessThan(MAX_MONTHS); // bails out early, no grinding
  });

  it('handles an interest-free loan as plain division', () => {
    const result = forecast({ principal: 12_000, annualRatePct: 0, emi: 1_000 }, BASELINE, FROM);
    expect(result.months).toBe(12);
    expect(result.totalInterest).toBe(0);
    expect(result.totalPaid).toBe(12_000);
  });
});

describe('forecast · EMI step-up', () => {
  it('leaves the first year alone, then raises the instalment', () => {
    const result = forecast(HOME, { kind: 'stepUp', pct: 10 }, FROM);
    expect(result.schedule[11].emi).toBeCloseTo(HOME.emi, 2); // month 12: unchanged
    expect(result.schedule[12].emi).toBeCloseTo(HOME.emi * 1.1, 0); // month 13: +10%
  });

  it('compounds the percentage year on year', () => {
    const result = forecast(HOME, { kind: 'stepUp', pct: 10 }, FROM);
    expect(result.schedule[24].emi).toBeCloseTo(HOME.emi * 1.1 * 1.1, 0); // month 25
  });

  it('accepts a flat annual increase instead of a percentage', () => {
    const result = forecast(HOME, { kind: 'stepUp', amount: 5_000 }, FROM);
    expect(result.schedule[12].emi).toBeCloseTo(HOME.emi + 5_000, 2);
    expect(result.schedule[24].emi).toBeCloseTo(HOME.emi + 10_000, 2);
  });

  it('clears the loan sooner and cheaper than the baseline', () => {
    const base = forecast(HOME, BASELINE, FROM);
    const stepped = forecast(HOME, { kind: 'stepUp', pct: 10 }, FROM);
    expect(stepped.months).toBeLessThan(base.months);
    expect(stepped.totalInterest).toBeLessThan(base.totalInterest);
  });

  it('a bigger step-up saves more', () => {
    const small = forecast(HOME, { kind: 'stepUp', pct: 5 }, FROM);
    const large = forecast(HOME, { kind: 'stepUp', pct: 15 }, FROM);
    expect(large.months).toBeLessThan(small.months);
    expect(large.totalInterest).toBeLessThan(small.totalInterest);
  });

  it('a zero step-up is just the baseline', () => {
    expect(forecast(HOME, { kind: 'stepUp', pct: 0 }, FROM).months).toBe(
      forecast(HOME, BASELINE, FROM).months,
    );
  });

  it('can rescue a loan the baseline would never clear', () => {
    const position = { principal: 1_000_000, annualRatePct: 12, emi: 9_000 };
    expect(forecast(position, BASELINE, FROM).neverPaysOff).toBe(true);
    expect(forecast(position, { kind: 'stepUp', pct: 15 }, FROM).neverPaysOff).toBe(false);
  });
});

describe('forecast · lump sums', () => {
  it('applies a yearly lump sum on each anniversary', () => {
    const result = forecast(HOME, { kind: 'lumpSum', amount: 100_000, yearly: true }, FROM);
    expect(result.schedule[10].extra).toBe(0); // month 11
    expect(result.schedule[11].extra).toBe(100_000); // month 12
    expect(result.schedule[23].extra).toBe(100_000); // month 24
  });

  it('applies a one-off payment in the month asked for', () => {
    const result = forecast(
      HOME,
      { kind: 'lumpSum', amount: 200_000, yearly: false, afterMonths: 5 },
      FROM,
    );
    expect(result.schedule[5].extra).toBe(200_000); // 5 months from now
    expect(result.schedule.filter((r) => r.extra > 0)).toHaveLength(1);
  });

  it('pays a one-off immediately when no delay is given', () => {
    const result = forecast(HOME, { kind: 'lumpSum', amount: 200_000, yearly: false }, FROM);
    expect(result.schedule[0].extra).toBe(200_000);
  });

  it('shortens the tenure without touching the instalment', () => {
    const base = forecast(HOME, BASELINE, FROM);
    const prepaid = forecast(HOME, { kind: 'lumpSum', amount: 100_000, yearly: true }, FROM);
    expect(prepaid.months).toBeLessThan(base.months);
    // The instalment is exactly what it always was — only the tenure moved.
    expect(prepaid.schedule[50].emi).toBeCloseTo(HOME.emi, 2);
  });

  it('never overpays past the outstanding balance', () => {
    const result = forecast(
      { principal: 50_000, annualRatePct: 9, emi: 10_000 },
      { kind: 'lumpSum', amount: 10_000_000, yearly: false },
      FROM,
    );
    const last = result.schedule[result.schedule.length - 1];
    expect(last.balance).toBe(0);
    expect(result.totalPaid).toBeLessThan(70_000);
  });

  it('a zero lump sum is just the baseline', () => {
    expect(forecast(HOME, { kind: 'lumpSum', amount: 0, yearly: true }, FROM).months).toBe(
      forecast(HOME, BASELINE, FROM).months,
    );
  });
});

describe('compareStrategies', () => {
  const strategies = [
    { label: 'Step up 10%/yr', strategy: { kind: 'stepUp', pct: 10 } as PrepaymentStrategy },
    {
      label: 'Bonus ₹1L/yr',
      strategy: { kind: 'lumpSum', amount: 100_000, yearly: true } as PrepaymentStrategy,
    },
  ];

  it('always leads with the baseline, measured as zero saving', () => {
    const [first] = compareStrategies(HOME, strategies, FROM);
    expect(first.label).toBe('Baseline');
    expect(first.interestSaved).toBe(0);
    expect(first.monthsSaved).toBe(0);
  });

  it('measures every strategy against the baseline, not each other', () => {
    const [base, stepUp, bonus] = compareStrategies(HOME, strategies, FROM);
    expect(stepUp.interestSaved).toBeCloseTo(
      base.forecast.totalInterest - stepUp.forecast.totalInterest,
      2,
    );
    expect(bonus.monthsSaved).toBe(base.forecast.months - bonus.forecast.months);
  });

  it('reports a real saving for both strategies on a 20-year home loan', () => {
    const [, stepUp, bonus] = compareStrategies(HOME, strategies, FROM);
    expect(stepUp.interestSaved).toBeGreaterThan(0);
    expect(stepUp.monthsSaved).toBeGreaterThan(0);
    expect(bonus.interestSaved).toBeGreaterThan(0);
    expect(bonus.monthsSaved).toBeGreaterThan(0);
  });

  it('returns just the baseline when nothing is compared', () => {
    expect(compareStrategies(HOME, [], FROM)).toHaveLength(1);
  });
});

describe('balanceCurve', () => {
  it('reads the balance out of each month', () => {
    const result = forecast({ principal: 3_000, annualRatePct: 0, emi: 1_000 }, BASELINE, FROM);
    expect(balanceCurve(result, 3)).toEqual([2_000, 1_000, 0]);
  });

  it('pads a short schedule with zeroes so curves share one axis', () => {
    const result = forecast({ principal: 2_000, annualRatePct: 0, emi: 1_000 }, BASELINE, FROM);
    expect(balanceCurve(result, 5)).toEqual([1_000, 0, 0, 0, 0]);
  });
});
