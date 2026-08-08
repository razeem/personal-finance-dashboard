import { computed, inject, Injectable, Signal } from '@angular/core';
import { StorageService } from '../storage/storage.service';
import { TaxConfigStore } from './tax-config-store';
import { OldRegimeDeductions, TaxRegime } from './tax.model';
import {
  AllocationTarget,
  DEFAULT_ALLOCATION_TARGET,
  DEFAULT_EMERGENCY_MULTIPLIER,
  DEFAULT_FINANCE_INPUTS,
  deriveFinance,
  EmergencyMultiplier,
  FinanceInputs,
  Goal,
  IdeaRow,
  LineItem,
  Loan,
  makeId,
  makeMonths,
  toMonthlyBilling,
} from './finance.model';

/** CRUD surface for one list living inside the shared finance model. */
export interface ListOps<T extends { id: string }> {
  items: Signal<T[]>;
  add(item: T): void;
  update(id: string, patch: Partial<T>): void;
  remove(id: string): void;
  /** Move an item from one index to another (drag-and-drop reordering). */
  reorder(previousIndex: number, currentIndex: number): void;
}

/**
 * The single shared financial state for the whole app.
 *
 * Every value is entered exactly once, in the pillar that owns it; every other
 * pillar reads `derived` (recomputed reactively) instead of re-typing anything.
 * Backed by one IndexedDB collection through the standard StorageService pattern.
 */
@Injectable({ providedIn: 'root' })
export class FinanceStore {
  private readonly store = inject(StorageService).bind<FinanceInputs>({
    key: 'finance',
    version: 6,
    defaults: DEFAULT_FINANCE_INPUTS,
    migrate: (raw) => {
      const data = raw as FinanceInputs;
      const income = data.income as FinanceInputs['income'] & { months?: unknown };
      // v1 → v2: seed the 12-month salary breakdown from the declared gross.
      let out =
        !income.months || !Array.isArray(income.months) || income.months.length !== 12
          ? { ...data, income: { ...income, months: makeMonths(income.gross ?? 0) } }
          : data;
      // v2 → v3: seed the spend-allocation target.
      if (!out.allocationTarget) {
        out = { ...out, allocationTarget: { ...DEFAULT_ALLOCATION_TARGET } };
      }
      // v3 → v4: split investing.contributions into mandatory / voluntary.
      const inv = out.investing as {
        contributions?: LineItem[];
        mandatory?: LineItem[];
        voluntary?: LineItem[];
      };
      if (!inv.mandatory || !inv.voluntary) {
        const old = inv.contributions ?? [];
        out = {
          ...out,
          investing: {
            mandatory: old.filter((c) => c.mandatory),
            voluntary: old.filter((c) => !c.mandatory),
          },
        };
      }
      // v4 → v5: seed the Saving pillar's emergency-fund multiplier.
      if (!out.saving) {
        out = { ...out, saving: { emergencyMultiplier: DEFAULT_EMERGENCY_MULTIPLIER } };
      }
      // v5 → v6: flat EMI line items become structured Loan entities.
      //
      // This RESHAPES ONLY — no amount is ever recomputed. `period` comes across
      // untouched, so `deriveFinance` returns exactly the same totalNeeds,
      // minimumIncome and emergencyTarget before and after. A yearly-billed loan
      // stays yearly; the Forecast tab asks the user to convert it, showing the
      // arithmetic, rather than rewriting their figure behind their back.
      const loanBucket = out.loan as { emis?: LineItem[]; loans?: Loan[] } | undefined;
      if (!loanBucket?.loans) {
        const legacy = loanBucket?.emis ?? [];
        out = {
          ...out,
          loan: {
            loans: legacy.map((item) => ({
              id: item.id ?? makeId('loan'),
              name: item.type ?? '',
              emi: Number.isFinite(item.value) ? item.value : 0,
              ...(item.period ? { period: item.period } : {}),
              principal: null,
              annualRatePct: null,
              startDate: null,
              kind: 'other' as const,
            })),
          },
        };
      }
      return out;
    },
  });
  private readonly taxConfig = inject(TaxConfigStore);

  readonly inputs = this.store.value;
  readonly ready = this.store.ready;
  readonly months = computed(() => this.inputs().income.months);
  readonly fyLabel = computed(() => this.taxConfig.fyLabel());

  /** The one source of every derived number (tax, minimum income, surplus, …). */
  readonly derived = computed(() => deriveFinance(this.inputs(), this.taxConfig.config()));

  // ---- Income pillar ----
  /**
   * Set the declared monthly salary. Smart-fills the breakdown: every month that
   * still matches the *previous* gross follows the new value, so genuine per-month
   * overrides are preserved.
   */
  setGross(value: number): void {
    const next = numeric(value);
    this.store.update((i) => {
      const prev = i.income.gross;
      const months = i.income.months.map((m) => (m.base === prev ? { ...m, base: next } : m));
      return { ...i, income: { ...i.income, gross: next, months } };
    });
  }
  setMonthBase(index: number, value: number): void {
    this.updateMonth(index, { base: numeric(value) });
  }
  setMonthBonus(index: number, value: number): void {
    this.updateMonth(index, { bonus: numeric(value) });
  }
  private updateMonth(index: number, patch: Partial<{ base: number; bonus: number }>): void {
    this.store.update((i) => ({
      ...i,
      income: {
        ...i.income,
        months: i.income.months.map((m, idx) => (idx === index ? { ...m, ...patch } : m)),
      },
    }));
  }
  setShortTermSavings(value: number): void {
    this.store.update((i) => ({ ...i, income: { ...i.income, shortTermSavings: numeric(value) } }));
  }
  readonly mustHaveGoals = this.goalList(
    (i) => i.goals.mustHave,
    (i, items) => ({ ...i, goals: { ...i.goals, mustHave: items } }),
  );
  readonly goodToHaveGoals = this.goalList(
    (i) => i.goals.goodToHave,
    (i, items) => ({ ...i, goals: { ...i.goals, goodToHave: items } }),
  );
  readonly ideas = this.list<IdeaRow>(
    (i) => i.ideas,
    (i, items) => ({ ...i, ideas: items }),
  );

  // ---- Spending pillar ----
  readonly needs = this.list<LineItem>(
    (i) => i.spending.needs,
    (i, items) => ({ ...i, spending: { ...i.spending, needs: items } }),
  );
  readonly wants = this.list<LineItem>(
    (i) => i.spending.wants,
    (i, items) => ({ ...i, spending: { ...i.spending, wants: items } }),
  );

  // ---- Loan pillar ----
  readonly loans = this.list<Loan>(
    (i) => i.loan.loans,
    (i, items) => ({ ...i, loan: { loans: items } }),
  );
  /** Restate a yearly-billed loan as its monthly twelfth (explicit user action only). */
  convertLoanToMonthly(id: string): void {
    this.store.update((i) => ({
      ...i,
      loan: { loans: i.loan.loans.map((l) => (l.id === id ? toMonthlyBilling(l) : l)) },
    }));
  }
  // ---- Saving pillar ----
  readonly emergencyMultiplier = computed(() => this.inputs().saving.emergencyMultiplier);
  setEmergencyMultiplier(multiplier: EmergencyMultiplier): void {
    this.store.update((i) => ({ ...i, saving: { ...i.saving, emergencyMultiplier: multiplier } }));
  }

  readonly insurancePremiums = this.list<LineItem>(
    (i) => i.insurance.premiums,
    (i, items) => ({ ...i, insurance: { premiums: items } }),
  );
  readonly investingMandatory = this.list<LineItem>(
    (i) => i.investing.mandatory,
    (i, items) => ({ ...i, investing: { ...i.investing, mandatory: items } }),
  );
  readonly investingVoluntary = this.list<LineItem>(
    (i) => i.investing.voluntary,
    (i, items) => ({ ...i, investing: { ...i.investing, voluntary: items } }),
  );

  // ---- Dashboard: spend-allocation target ----
  readonly allocationTarget = computed(() => this.inputs().allocationTarget);
  setAllocationTarget(patch: Partial<AllocationTarget>): void {
    this.store.update((i) => ({
      ...i,
      allocationTarget: {
        living: clampPct(patch.living ?? i.allocationTarget.living),
        safety: clampPct(patch.safety ?? i.allocationTarget.safety),
        growth: clampPct(patch.growth ?? i.allocationTarget.growth),
      },
    }));
  }

  // ---- Tax pillar ----
  setRegime(regime: TaxRegime): void {
    this.store.update((i) => ({ ...i, tax: { ...i.tax, regime } }));
  }
  setDeduction(key: keyof OldRegimeDeductions, value: number): void {
    this.store.update((i) => ({
      ...i,
      tax: { ...i.tax, deductions: { ...i.tax.deductions, [key]: numeric(value) } },
    }));
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
  reset(): Promise<void> {
    return this.store.reset();
  }

  // ---- internals ----
  private list<T extends { id: string }>(
    select: (i: FinanceInputs) => T[],
    replace: (i: FinanceInputs, items: T[]) => FinanceInputs,
  ): ListOps<T> {
    return {
      items: computed(() => select(this.inputs())),
      add: (item) => this.store.update((i) => replace(i, [...select(i), item])),
      update: (id, patch) =>
        this.store.update((i) =>
          replace(
            i,
            select(i).map((x) => (x.id === id ? { ...x, ...patch } : x)),
          ),
        ),
      remove: (id) =>
        this.store.update((i) =>
          replace(
            i,
            select(i).filter((x) => x.id !== id),
          ),
        ),
      reorder: (previousIndex, currentIndex) =>
        this.store.update((i) => {
          const items = [...select(i)];
          if (
            previousIndex < 0 ||
            previousIndex >= items.length ||
            currentIndex < 0 ||
            currentIndex >= items.length
          ) {
            return i;
          }
          const [moved] = items.splice(previousIndex, 1);
          items.splice(currentIndex, 0, moved);
          return replace(i, items);
        }),
    };
  }

  private goalList(
    select: (i: FinanceInputs) => Goal[],
    replace: (i: FinanceInputs, items: Goal[]) => FinanceInputs,
  ): ListOps<Goal> {
    return this.list<Goal>(select, replace);
  }
}

function numeric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Clamp an allocation percentage to 0–100. */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
