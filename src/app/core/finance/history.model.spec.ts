import { DEFAULT_FINANCE_INPUTS, deriveFinance, makeLineItem, makeMonths } from './finance.model';
import {
  aggregateByFy,
  applyEdit,
  carryForward,
  fyLabelOf,
  DEFAULT_HISTORY,
  EMPTY_BREAKDOWN,
  fyKeyRange,
  fyStartKey,
  HistoryState,
  isUserAuthored,
  latestBefore,
  MonthSnapshot,
  monthKey,
  monthKeyRange,
  monthLabel,
  parseMonthKey,
  previousMonthKey,
  scaleBreakdownTo,
  shiftMonthKey,
  snapshotFromDerived,
  sortedKeys,
  sumBreakdown,
} from './history.model';

describe('month keys', () => {
  it('formats a date as YYYY-MM in local time', () => {
    expect(monthKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(monthKey(new Date(2026, 11, 1))).toBe('2026-12');
  });

  it('round-trips through parseMonthKey', () => {
    const date = parseMonthKey('2026-07')!;
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6); // July
    expect(date.getDate()).toBe(1);
    expect(monthKey(date)).toBe('2026-07');
  });

  it('rejects malformed keys', () => {
    expect(parseMonthKey('2026-13')).toBeNull();
    expect(parseMonthKey('2026-00')).toBeNull();
    expect(parseMonthKey('202607')).toBeNull();
    expect(parseMonthKey('')).toBeNull();
  });

  it('shifts across year boundaries in both directions', () => {
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-04', 12)).toBe('2027-04');
    expect(previousMonthKey('2026-01')).toBe('2025-12');
  });

  it('sorts correctly as plain strings — the whole point of the format', () => {
    const keys = ['2026-10', '2025-12', '2026-02', '2026-09'];
    expect([...keys].sort()).toEqual(['2025-12', '2026-02', '2026-09', '2026-10']);
  });

  it('labels a month readably', () => {
    expect(monthLabel('2026-04')).toBe('Apr 2026');
    expect(monthLabel('nonsense')).toBe('nonsense');
  });

  it('builds inclusive ranges, and nothing for a backwards one', () => {
    expect(monthKeyRange('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(monthKeyRange('2026-04', '2026-04')).toEqual(['2026-04']);
    expect(monthKeyRange('2026-06', '2026-01')).toEqual([]);
    expect(monthKeyRange('bad', '2026-01')).toEqual([]);
  });
});

describe('fyKeyRange (Indian financial year, Apr → Mar)', () => {
  it('runs April to March for a date after April', () => {
    const range = fyKeyRange(new Date(2026, 6, 4)); // July 2026 → FY 2026-27
    expect(range).toHaveLength(12);
    expect(range[0]).toBe('2026-04');
    expect(range[11]).toBe('2027-03');
  });

  it('puts January in the FY that started the previous April', () => {
    const range = fyKeyRange(new Date(2027, 0, 20)); // Jan 2027 → still FY 2026-27
    expect(range[0]).toBe('2026-04');
    expect(range[11]).toBe('2027-03');
  });

  it('treats April 1st as the first day of the new FY', () => {
    expect(fyStartKey(new Date(2026, 3, 1))).toBe('2026-04');
    expect(fyStartKey(new Date(2026, 2, 31))).toBe('2025-04');
  });

  it('is strictly ascending with no gaps or repeats', () => {
    const range = fyKeyRange(new Date(2026, 8, 1));
    expect(new Set(range).size).toBe(12);
    expect([...range].sort()).toEqual(range);
  });
});

describe('snapshotFromDerived', () => {
  const inputs = {
    ...DEFAULT_FINANCE_INPUTS,
    income: { gross: 100_000, shortTermSavings: 5_000, months: makeMonths(100_000) },
    spending: {
      needs: [makeLineItem('Rent', 20_000)],
      wants: [makeLineItem('Dining', 10_000)],
    },
    loan: { emis: [makeLineItem('Car', 15_000)] },
    insurance: { premiums: [makeLineItem('Term', 24_000, 'yearly')] }, // ₹2,000/mo
    investing: {
      mandatory: [makeLineItem('EPF', 1_850)],
      voluntary: [makeLineItem('MF', 3_000)],
    },
    tax: { regime: 'new' as const, deductions: DEFAULT_FINANCE_INPUTS.tax.deductions },
  };

  it('splits EMIs back out of needs so the breakdown is a partition', () => {
    const snapshot = snapshotFromDerived(deriveFinance(inputs));
    // totalNeeds is 20,000 spending + 15,000 EMIs — they must not be counted twice.
    expect(snapshot.breakdown.needs).toBe(20_000);
    expect(snapshot.breakdown.emis).toBe(15_000);
  });

  it('captures every bucket the pillars own', () => {
    const snapshot = snapshotFromDerived(deriveFinance(inputs));
    expect(snapshot.breakdown).toEqual({
      needs: 20_000,
      wants: 10_000,
      insurance: 2_000, // yearly ÷ 12
      investingMandatory: 1_850,
      investingVoluntary: 3_000,
      emis: 15_000,
      tax: 0, // ₹12L under the new regime is fully rebated
    });
  });

  it('keeps expenses equal to the sum of the breakdown', () => {
    const snapshot = snapshotFromDerived(deriveFinance(inputs));
    expect(snapshot.expenses).toBe(sumBreakdown(snapshot.breakdown));
    expect(snapshot.expenses).toBe(51_850);
  });

  it('records income as the declared monthly gross, and excludes savings from expenses', () => {
    const snapshot = snapshotFromDerived(deriveFinance(inputs));
    expect(snapshot.income).toBe(100_000);
    // Income − expenses is what the month put aside; the ₹5,000 short-term
    // savings target is not an outgoing.
    expect(snapshot.income - snapshot.expenses).toBe(48_150);
  });

  it('defaults to an auto source but honours an explicit one', () => {
    expect(snapshotFromDerived(deriveFinance(inputs)).source).toBe('auto');
    expect(snapshotFromDerived(deriveFinance(inputs), 'backfill').source).toBe('backfill');
  });

  it('carries the monthly tax figure through', () => {
    const taxed = snapshotFromDerived(
      deriveFinance({ ...inputs, tax: { ...inputs.tax, regime: 'old' } }),
    );
    expect(taxed.breakdown.tax).toBeCloseTo(13_650, 2);
  });
});

describe('carryForward', () => {
  const previous: MonthSnapshot = {
    income: 90_000,
    expenses: 40_000,
    breakdown: {
      needs: 20_000,
      wants: 8_000,
      insurance: 2_000,
      investingMandatory: 1_000,
      investingVoluntary: 4_000,
      emis: 5_000,
      tax: 0,
    },
    source: 'manual',
  };

  it('repeats the previous month’s figures', () => {
    const next = carryForward(previous);
    expect(next.income).toBe(90_000);
    expect(next.expenses).toBe(40_000);
    expect(next.breakdown).toEqual(previous.breakdown);
  });

  it('downgrades a manual month to auto — a carried figure is only a suggestion', () => {
    expect(carryForward(previous).source).toBe('auto');
    expect(carryForward({ ...previous, source: 'backfill' }).source).toBe('auto');
  });

  it('deep-copies the breakdown so editing the carried month cannot mutate the source', () => {
    const next = carryForward(previous);
    next.breakdown.needs = 999;
    expect(previous.breakdown.needs).toBe(20_000);
  });
});

describe('applyEdit', () => {
  const base: MonthSnapshot = {
    income: 50_000,
    expenses: 30_000,
    breakdown: {
      needs: 20_000,
      wants: 5_000,
      insurance: 1_000,
      investingMandatory: 1_000,
      investingVoluntary: 1_000,
      emis: 2_000,
      tax: 0,
    },
    source: 'auto',
  };

  it('marks any edit as the user’s word', () => {
    expect(applyEdit(base, { income: 60_000 }).source).toBe('manual');
    expect(applyEdit(base, { income: 60_000 }, 'backfill').source).toBe('backfill');
  });

  it('merges a partial breakdown instead of replacing it', () => {
    const edited = applyEdit(base, { breakdown: { ...base.breakdown, wants: 9_000 } });
    expect(edited.breakdown.wants).toBe(9_000);
    expect(edited.breakdown.needs).toBe(20_000); // untouched
  });

  it('re-derives expenses so they can never drift from the breakdown', () => {
    const edited = applyEdit(base, { breakdown: { ...base.breakdown, needs: 25_000 } });
    expect(edited.expenses).toBe(35_000);
    expect(edited.expenses).toBe(sumBreakdown(edited.breakdown));
  });

  it('leaves the original untouched', () => {
    applyEdit(base, { income: 1 });
    expect(base.income).toBe(50_000);
    expect(base.source).toBe('auto');
  });
});

describe('isUserAuthored', () => {
  const of = (source: MonthSnapshot['source']): MonthSnapshot => ({
    income: 0,
    expenses: 0,
    breakdown: { ...EMPTY_BREAKDOWN },
    source,
  });

  it('protects manual and backfilled months, not auto ones', () => {
    expect(isUserAuthored(of('manual'))).toBe(true);
    expect(isUserAuthored(of('backfill'))).toBe(true);
    expect(isUserAuthored(of('auto'))).toBe(false);
    expect(isUserAuthored(undefined)).toBe(false);
  });
});

describe('scaleBreakdownTo', () => {
  const breakdown = {
    needs: 20_000,
    wants: 10_000,
    insurance: 2_000,
    investingMandatory: 1_850,
    investingVoluntary: 3_000,
    emis: 15_000,
    tax: 0,
  };

  it('keeps the proportions and only changes the size', () => {
    const doubled = scaleBreakdownTo(breakdown, sumBreakdown(breakdown) * 2);
    expect(doubled.needs).toBe(40_000);
    expect(doubled.wants).toBe(20_000);
    expect(doubled.emis).toBe(30_000);
  });

  it('always sums to exactly the requested total, rounding included', () => {
    // 51,850 → 10,000 divides unevenly across seven categories.
    const scaled = scaleBreakdownTo(breakdown, 10_000);
    expect(sumBreakdown(scaled)).toBe(10_000);
  });

  it('puts everything in needs when there are no proportions to keep', () => {
    const fromNothing = scaleBreakdownTo(EMPTY_BREAKDOWN, 25_000);
    expect(fromNothing.needs).toBe(25_000);
    expect(sumBreakdown(fromNothing)).toBe(25_000);
  });

  it('treats a negative or non-finite total as zero', () => {
    expect(sumBreakdown(scaleBreakdownTo(breakdown, -500))).toBe(0);
    expect(sumBreakdown(scaleBreakdownTo(breakdown, NaN))).toBe(0);
  });

  it('leaves the original untouched', () => {
    scaleBreakdownTo(breakdown, 1);
    expect(breakdown.needs).toBe(20_000);
  });
});

describe('aggregateByFy', () => {
  const withBreakdown = (income: number, needs: number, wants: number): MonthSnapshot => ({
    income,
    expenses: needs + wants,
    breakdown: { ...EMPTY_BREAKDOWN, needs, wants },
    source: 'manual',
  });

  it('labels a financial year the Indian way', () => {
    expect(fyLabelOf('2026-04')).toBe('FY 2026-27');
    expect(fyLabelOf('2027-03')).toBe('FY 2026-27'); // still the same FY
    expect(fyLabelOf('2027-04')).toBe('FY 2027-28');
  });

  it('sums months into their financial year', () => {
    const totals = aggregateByFy({
      ...DEFAULT_HISTORY,
      months: {
        '2026-04': withBreakdown(100, 40, 10),
        '2026-05': withBreakdown(100, 40, 10),
      },
    });
    expect(totals).toHaveLength(1);
    expect(totals[0].label).toBe('FY 2026-27');
    expect(totals[0].income).toBe(200);
    expect(totals[0].expenses).toBe(100);
    expect(totals[0].breakdown.needs).toBe(80);
    expect(totals[0].monthCount).toBe(2);
  });

  it('splits at April, not January', () => {
    const totals = aggregateByFy({
      ...DEFAULT_HISTORY,
      months: {
        '2027-01': withBreakdown(10, 1, 0), // still FY 2026-27
        '2027-03': withBreakdown(10, 1, 0), // last month of FY 2026-27
        '2027-04': withBreakdown(10, 1, 0), // first month of FY 2027-28
      },
    });
    expect(totals.map((t) => t.label)).toEqual(['FY 2026-27', 'FY 2027-28']);
    expect(totals[0].monthCount).toBe(2);
    expect(totals[1].monthCount).toBe(1);
  });

  it('returns years oldest first regardless of insertion order', () => {
    const totals = aggregateByFy({
      ...DEFAULT_HISTORY,
      months: {
        '2027-06': withBreakdown(1, 1, 0),
        '2025-06': withBreakdown(1, 1, 0),
        '2026-06': withBreakdown(1, 1, 0),
      },
    });
    expect(totals.map((t) => t.key)).toEqual(['2025-04', '2026-04', '2027-04']);
  });

  it('reports a partial year honestly rather than padding it', () => {
    const totals = aggregateByFy({
      ...DEFAULT_HISTORY,
      months: { '2026-04': withBreakdown(100, 40, 10) },
    });
    expect(totals[0].monthCount).toBe(1);
    expect(totals[0].income).toBe(100);
  });

  it('has nothing to say about an empty history', () => {
    expect(aggregateByFy(DEFAULT_HISTORY)).toEqual([]);
  });
});

describe('state helpers', () => {
  const snap = (income: number): MonthSnapshot => ({
    income,
    expenses: 0,
    breakdown: {
      needs: 0,
      wants: 0,
      insurance: 0,
      investingMandatory: 0,
      investingVoluntary: 0,
      emis: 0,
      tax: 0,
    },
    source: 'manual',
  });

  const state: HistoryState = {
    ...DEFAULT_HISTORY,
    trackingStart: '2026-01',
    months: {
      '2026-03': snap(3),
      '2026-01': snap(1),
      '2026-02': snap(2),
    },
  };

  it('sorts keys ascending regardless of insertion order', () => {
    expect(sortedKeys(state)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('finds the nearest earlier snapshot, skipping gaps', () => {
    expect(latestBefore(state, '2026-03')?.income).toBe(2);
    expect(latestBefore(state, '2026-09')?.income).toBe(3); // gap: falls back to March
    expect(latestBefore(state, '2026-01')).toBeNull(); // nothing precedes the first
  });

  it('is exclusive of the key itself', () => {
    expect(latestBefore(state, '2026-02')?.income).toBe(1);
  });
});
