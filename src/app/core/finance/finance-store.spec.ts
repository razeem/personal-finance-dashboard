import { signal, Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CollectionConfig, PersistentCollection, StorageService } from '../storage/storage.service';
import { FinanceStore } from './finance-store';
import {
  deriveFinance,
  DEFAULT_FINANCE_INPUTS,
  FinanceInputs,
  isForecastReady,
  loanGaps,
  makeLineItem,
  makeLoan,
  makeMonths,
  monthlyEmi,
  sumLoansMonthly,
  toMonthlyBilling,
} from './finance.model';
import { KNOWN_COLLECTIONS } from '../transfer/transfer.model';

/** In-memory StorageService that hands back a pre-seeded document at an old version. */
class MemoryStorage {
  readonly seed: Record<string, { version: number; data: unknown }> = {};

  bind<T>(config: CollectionConfig<T>): PersistentCollection<T> {
    const stored = this.seed[config.key];
    const initial =
      stored && stored.version !== config.version && config.migrate
        ? config.migrate(stored.data, stored.version)
        : ((stored?.data as T) ?? config.defaults);
    const value = signal<T>(initial);
    const ready = signal(true);
    const set = (next: T) => value.set(next);
    return {
      value: value.asReadonly() as Signal<T>,
      ready: ready.asReadonly(),
      set,
      update: (updater) => set(updater(value())),
      patch: (partial) => set({ ...value(), ...partial }),
      reset: async () => value.set(config.defaults),
      flush: async () => undefined,
    };
  }
}

/**
 * A finance v5 document, as it existed on disk before loans became entities:
 * EMIs were flat line items and could be billed yearly.
 */
function v5Document(emis: unknown[]): Record<string, unknown> {
  return {
    income: { gross: 100_000, shortTermSavings: 5_000, months: makeMonths(100_000) },
    goals: { mustHave: [], goodToHave: [] },
    ideas: [],
    spending: { needs: [makeLineItem('Rent', 25_000)], wants: [makeLineItem('Dining', 10_000)] },
    loan: { emis },
    saving: { emergencyMultiplier: 6 },
    insurance: { premiums: [makeLineItem('Term', 24_000, 'yearly')] },
    investing: { mandatory: [makeLineItem('EPF', 1_850)], voluntary: [] },
    tax: { regime: 'old', deductions: DEFAULT_FINANCE_INPUTS.tax.deductions },
    allocationTarget: { living: 75, safety: 15, growth: 10 },
  };
}

function storeFromV5(emis: unknown[]): FinanceStore {
  const storage = new MemoryStorage();
  storage.seed['finance'] = { version: 5, data: v5Document(emis) };
  TestBed.configureTestingModule({
    providers: [{ provide: StorageService, useValue: storage }],
  });
  return TestBed.inject(FinanceStore);
}

describe('finance v5 → v6 migration', () => {
  const yearlyEmi = { id: 'l1', type: 'Car loan', value: 24_000, period: 'yearly' };
  const monthlyEmiItem = { id: 'l2', type: 'Home loan', value: 35_000 };

  it('reshapes a line item into a Loan, keeping name and amount', () => {
    const loans = storeFromV5([monthlyEmiItem]).inputs().loan.loans;
    expect(loans).toHaveLength(1);
    expect(loans[0]).toMatchObject({
      id: 'l2',
      name: 'Home loan',
      emi: 35_000,
      principal: null,
      annualRatePct: null,
      startDate: null,
      kind: 'other',
    });
  });

  it('carries a yearly billing period across untouched', () => {
    const [loan] = storeFromV5([yearlyEmi]).inputs().loan.loans;
    expect(loan.period).toBe('yearly');
    expect(loan.emi).toBe(24_000); // NOT converted
  });

  it('leaves a monthly loan with no period rather than inventing one', () => {
    const [loan] = storeFromV5([monthlyEmiItem]).inputs().loan.loans;
    expect(loan.period).toBeUndefined();
  });

  // The whole point of reshaping rather than recomputing: a user who upgrades
  // sees exactly the same budget. If this ever fails, the migration is lying.
  it('does not move a single derived figure', () => {
    const before = deriveFinance(
      // What v5 produced: period-aware line items.
      {
        ...(v5Document([]) as unknown as FinanceInputs),
        loan: { loans: [{ ...makeLoan('Car loan', 24_000), id: 'l1', period: 'yearly' }] },
      },
    );
    const after = deriveFinance(storeFromV5([yearlyEmi]).inputs());

    expect(after.totalLoanEmis).toBe(before.totalLoanEmis);
    expect(after.totalNeeds).toBe(before.totalNeeds);
    expect(after.minimumIncome).toBe(before.minimumIncome);
    expect(after.surplus).toBe(before.surplus);
    expect(after.allocation.living).toBe(before.allocation.living);
    expect(after.emergencyTarget).toBe(before.emergencyTarget);
  });

  it('still counts a yearly loan as its twelfth in the budget', () => {
    const derived = deriveFinance(storeFromV5([yearlyEmi]).inputs());
    expect(derived.totalLoanEmis).toBe(2_000); // 24,000 / 12
    expect(derived.totalNeeds).toBe(27_000); // 25,000 rent + 2,000
  });

  it('handles a v5 document with no loans at all', () => {
    expect(storeFromV5([]).inputs().loan.loans).toEqual([]);
  });

  it('leaves an already-migrated v6 document alone', () => {
    const storage = new MemoryStorage();
    const loans = [{ ...makeLoan('Car', 5_000), principal: 200_000, annualRatePct: 9 }];
    storage.seed['finance'] = {
      version: 6,
      data: { ...v5Document([]), loan: { loans } },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: StorageService, useValue: storage }],
    });
    expect(TestBed.inject(FinanceStore).inputs().loan.loans[0].principal).toBe(200_000);
  });

  it('is declared at the same version in KNOWN_COLLECTIONS', () => {
    // A stale entry here makes exported documents look `newer-unsupported`
    // and silently skips them on import.
    expect(KNOWN_COLLECTIONS['finance'].version).toBe(6);
  });
});

describe('loan helpers', () => {
  it('counts a yearly loan as its monthly twelfth', () => {
    expect(monthlyEmi({ ...makeLoan('x', 24_000), period: 'yearly' })).toBe(2_000);
    expect(monthlyEmi(makeLoan('x', 2_000))).toBe(2_000);
  });

  it('sums a mixed list on a monthly basis', () => {
    expect(
      sumLoansMonthly([makeLoan('a', 5_000), { ...makeLoan('b', 24_000), period: 'yearly' }]),
    ).toBe(7_000);
  });

  it('treats a non-finite EMI as zero', () => {
    expect(monthlyEmi(makeLoan('x', NaN))).toBe(0);
  });
});

describe('forecast readiness', () => {
  const complete = { ...makeLoan('Home', 35_000), principal: 3_000_000, annualRatePct: 8.5 };

  it('needs an outstanding balance, a rate and a monthly EMI', () => {
    expect(isForecastReady(complete)).toBe(true);
    expect(loanGaps(complete)).toEqual([]);
  });

  it('lists everything a freshly migrated loan is missing', () => {
    expect(loanGaps(makeLoan('Car', 5_000))).toEqual(['principal', 'rate']);
  });

  it('treats a zero rate as declared — an interest-free loan is forecastable', () => {
    expect(isForecastReady({ ...complete, annualRatePct: 0 })).toBe(true);
  });

  it('flags yearly billing as a gap, since the amortization core is monthly', () => {
    const yearly = { ...complete, period: 'yearly' as const };
    expect(loanGaps(yearly)).toEqual(['billedYearly']);
    expect(isForecastReady(yearly)).toBe(false);
  });

  it('reports every gap at once so the prompt can list them', () => {
    const bare = { ...makeLoan('Car', 0), period: 'yearly' as const };
    expect(loanGaps(bare)).toEqual(['emi', 'principal', 'rate', 'billedYearly']);
  });
});

describe('toMonthlyBilling', () => {
  it('restates a yearly loan as its twelfth', () => {
    const converted = toMonthlyBilling({ ...makeLoan('Car', 24_000), period: 'yearly' });
    expect(converted.emi).toBe(2_000);
    expect(converted.period).toBe('monthly');
    expect(isForecastReady({ ...converted, principal: 100_000, annualRatePct: 9 })).toBe(true);
  });

  it('leaves a monthly loan exactly as it was', () => {
    const monthly = makeLoan('Car', 2_000);
    expect(toMonthlyBilling(monthly)).toBe(monthly);
  });

  it('rounds to paise rather than carrying float noise', () => {
    expect(toMonthlyBilling({ ...makeLoan('x', 10_000), period: 'yearly' }).emi).toBe(833.33);
  });

  it('does not change what the budget counts', () => {
    const yearly = { ...makeLoan('Car', 24_000), period: 'yearly' as const };
    expect(monthlyEmi(toMonthlyBilling(yearly))).toBe(monthlyEmi(yearly));
  });
});
