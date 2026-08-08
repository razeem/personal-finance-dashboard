import {
  calculateTax,
  DEFAULT_OLD_REGIME_DEDUCTIONS,
  DEFAULT_TAX_CONFIG,
  OldRegimeDeductions,
  TaxConfig,
  TaxRegime,
  TaxResult,
} from './tax.model';

export type LinePeriod = 'monthly' | 'yearly';

/**
 * Emergency-fund size as a multiple of the minimum monthly (essential) expense.
 * Tiers come from the classic guideline: a stable earner with no dependents needs
 * ~3×, less-stable / dependent situations 6×, the least stable 12×.
 */
export type EmergencyMultiplier = 3 | 6 | 12;

/** One reference profile in the emergency-fund formula (mirrors the infographic). */
export interface EmergencyTier {
  multiplier: EmergencyMultiplier;
  stableJob: boolean;
  stableIncome: boolean;
  dependents: boolean;
}

/** The three selectable profiles, exactly as laid out in the infographic. */
export const EMERGENCY_TIERS: readonly EmergencyTier[] = [
  { multiplier: 3, stableJob: true, stableIncome: true, dependents: false },
  { multiplier: 6, stableJob: true, stableIncome: false, dependents: true },
  { multiplier: 12, stableJob: false, stableIncome: false, dependents: true },
];

export const DEFAULT_EMERGENCY_MULTIPLIER: EmergencyMultiplier = 6;

export interface LineItem {
  id: string;
  type: string;
  value: number;
  /** How often `value` is paid. Absent = monthly. Used e.g. for yearly insurance premiums. */
  period?: LinePeriod;
  /** Mandatory investment (EPF/NPS) — bucketed under "Living", not "Growth & Freedom". */
  mandatory?: boolean;
}

/** Spend-allocation target: Living : Safety : Growth & Freedom (percentages, sum 100). */
export interface AllocationTarget {
  living: number;
  safety: number;
  growth: number;
}

export const DEFAULT_ALLOCATION_TARGET: AllocationTarget = { living: 75, safety: 15, growth: 10 };

export interface Goal {
  id: string;
  text: string;
}

/** An income idea rated on the ICER axes (each 1–5). */
export interface IdeaRow {
  id: string;
  name: string;
  interest: number;
  capability: number;
  effortlessness: number;
  return: number;
}

/** One financial-year month's pay: recurring base + one-off bonus. */
export interface MonthSalary {
  base: number;
  bonus: number;
}

export interface FinanceInputs {
  income: {
    /** The declared typical monthly salary (drives the monthly budget + fills the breakdown). */
    gross: number;
    shortTermSavings: number;
    /** 12-month salary breakdown, April → March (Indian FY). Drives the annual tax. */
    months: MonthSalary[];
  };
  goals: {
    mustHave: Goal[];
    goodToHave: Goal[];
  };
  ideas: IdeaRow[];
  spending: {
    needs: LineItem[];
    wants: LineItem[];
  };
  loan: { emis: LineItem[] };
  /** Saving pillar: the chosen emergency-fund multiplier (× essential expense). */
  saving: { emergencyMultiplier: EmergencyMultiplier };
  insurance: { premiums: LineItem[] };
  // Mandatory (EPF/NPS) → bucketed under Living; voluntary → Growth & Freedom.
  investing: { mandatory: LineItem[]; voluntary: LineItem[] };
  tax: {
    regime: TaxRegime;
    deductions: OldRegimeDeductions;
  };
  /** Target split of monthly money across Living / Safety / Growth & Freedom. */
  allocationTarget: AllocationTarget;
}

export interface DerivedFinance {
  /** Monthly gross income (the value entered in the Income pillar). */
  gross: number;
  /** Annualised gross (`gross * 12`) — the basis for the yearly tax computation. */
  annualGross: number;
  totalNeeds: number;
  totalWants: number;
  totalLoanEmis: number;
  totalInsurance: number;
  totalInvestments: number;
  shortTermSavings: number;
  /** The full annual tax result (India tax is assessed yearly). */
  tax: TaxResult;
  /** Annual tax (`tax.totalTax`). */
  taxAnnual: number;
  /** Monthly tax (`taxAnnual / 12`) — used in the monthly budget figures below. */
  taxPayable: number;
  netIncome: number;
  minimumIncome: number;
  surplus: number;
  /**
   * Minimum monthly expense to keep running if income stopped — the basis for the
   * emergency fund. = needs (spending) + loan EMIs + mandatory investments.
   * (`totalNeeds` already rolls in loan EMIs, so this is `totalNeeds + mandatoryInvestments`.)
   */
  minimumMonthlyExpense: number;
  /** Chosen emergency-fund multiplier (× essential expense). */
  emergencyMultiplier: EmergencyMultiplier;
  /** Recommended emergency-fund corpus = minimumMonthlyExpense × emergencyMultiplier. */
  emergencyTarget: number;
  /** Mandatory investments (EPF/NPS) — counted under Living. */
  mandatoryInvestments: number;
  discretionaryInvestments: number;
  /** Monthly spend-allocation buckets (amounts). */
  allocation: {
    living: number;
    safety: number;
    growthFreedom: number;
    total: number;
  };
}

let idCounter = 0;

/** Stable-ish unique id for list rows (crypto in the browser, counter fallback). */
export function makeId(prefix = 'id'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function makeLineItem(type = '', value = 0, period?: LinePeriod): LineItem {
  return period ? { id: makeId('li'), type, value, period } : { id: makeId('li'), type, value };
}

/** The monthly-equivalent of a line item (yearly amounts are divided by 12). */
export function monthlyValue(item: LineItem): number {
  const v = Number.isFinite(item.value) ? item.value : 0;
  return item.period === 'yearly' ? v / 12 : v;
}

/** Sum a list as monthly-equivalents (period-aware). */
export function sumLineItemsMonthly(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + monthlyValue(item), 0);
}

export function makeGoal(text = ''): Goal {
  return { id: makeId('goal'), text };
}

export function makeIdea(name = ''): IdeaRow {
  return { id: makeId('idea'), name, interest: 3, capability: 3, effortlessness: 3, return: 3 };
}

export function sumLineItems(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0);
}

/** FY month labels, April → March (Indian financial year). */
export const FY_MONTHS = [
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
  'Jan',
  'Feb',
  'Mar',
] as const;

/** Build a fresh 12-month breakdown, every month pre-filled with `base`, no bonus. */
export function makeMonths(base: number): MonthSalary[] {
  return FY_MONTHS.map(() => ({ base: Math.max(0, base || 0), bonus: 0 }));
}

/** Annual total from the 12-month breakdown: Σ(base + bonus). */
export function sumMonths(months: readonly MonthSalary[]): number {
  return months.reduce(
    (sum, m) =>
      sum + (Number.isFinite(m.base) ? m.base : 0) + (Number.isFinite(m.bonus) ? m.bonus : 0),
    0,
  );
}

/** Average of the four 1–5 ICER axes. */
export function icerScore(row: IdeaRow): number {
  return (row.interest + row.capability + row.effortlessness + row.return) / 4;
}

export const DEFAULT_FINANCE_INPUTS: FinanceInputs = {
  // Gross is now entered MONTHLY (₹1,00,000/mo ≈ ₹12,00,000/yr); the 12-month
  // breakdown (Apr→Mar) defaults to that same figure every month.
  income: { gross: 100_000, shortTermSavings: 0, months: makeMonths(100_000) },
  goals: {
    mustHave: [
      makeGoal('Never face a financial crisis'),
      makeGoal('Reach upper-middle class in 5 years'),
      makeGoal('Retire peacefully'),
    ],
    goodToHave: [makeGoal('Take a trip')],
  },
  ideas: [],
  spending: { needs: [], wants: [] },
  loan: { emis: [] },
  saving: { emergencyMultiplier: DEFAULT_EMERGENCY_MULTIPLIER },
  insurance: {
    // Insurance is usually paid yearly.
    premiums: [
      makeLineItem('Term insurance', 0, 'yearly'),
      makeLineItem('Health insurance', 0, 'yearly'),
    ],
  },
  // Mandatory (EPF ~₹1,850/mo statutory + NPS) → Living; voluntary → Growth.
  investing: {
    mandatory: [makeLineItem('EPF', 1_850), makeLineItem('NPS', 0)],
    voluntary: [],
  },
  tax: { regime: 'old', deductions: { ...DEFAULT_OLD_REGIME_DEDUCTIONS } },
  allocationTarget: { ...DEFAULT_ALLOCATION_TARGET },
};

/**
 * The single source of every derived number. Gross Income is the one entered
 * value that drives tax; Minimum Income is derived (never re-typed). This breaks
 * the Gross ↔ Tax ↔ Minimum cycle: Gross is input, Minimum is a comparison target.
 *
 * Inputs are entered MONTHLY (income, spending, savings, insurance, investments).
 * India tax is assessed yearly, so gross is annualised (×12) for the tax model and
 * the resulting annual tax is divided back to a monthly figure; every budget number
 * returned here (net income, minimum income, surplus) is therefore MONTHLY.
 */
export function deriveFinance(
  inputs: FinanceInputs,
  taxConfig: TaxConfig = DEFAULT_TAX_CONFIG,
): DerivedFinance {
  const gross = Math.max(0, inputs.income.gross || 0); // typical monthly base
  // Annual gross is the actual sum of the 12-month breakdown (base + bonus per
  // month); falls back to gross × 12 if the breakdown is somehow absent.
  const months = inputs.income.months;
  const annualGross = months && months.length ? sumMonths(months) : gross * 12;
  const shortTermSavings = Math.max(0, inputs.income.shortTermSavings || 0);

  const totalLoanEmis = sumLineItemsMonthly(inputs.loan.emis); // period-aware (yearly ÷ 12)
  const totalNeeds = sumLineItems(inputs.spending.needs) + totalLoanEmis; // EMIs roll into Needs
  const totalWants = sumLineItems(inputs.spending.wants);
  const totalInsurance = sumLineItemsMonthly(inputs.insurance.premiums); // period-aware (yearly ÷ 12)
  // Period-aware too: a yearly SIP/PPF top-up counts as its monthly twelfth, so the
  // list footers, the pillar tile and the dashboard all agree on one number.
  const mandatoryInvestments = sumLineItemsMonthly(inputs.investing.mandatory);
  const discretionaryInvestments = sumLineItemsMonthly(inputs.investing.voluntary);
  const totalInvestments = mandatoryInvestments + discretionaryInvestments;

  // Tax is computed on the ANNUAL gross, then brought back to a monthly figure.
  const tax = calculateTax(inputs.tax.regime, annualGross, inputs.tax.deductions, taxConfig);
  const taxAnnual = tax.totalTax;
  const taxPayable = taxAnnual / 12; // monthly
  const netIncome = gross - taxPayable;

  // Literal spec formula (subtracts tax); all terms monthly.
  const minimumIncome =
    totalNeeds + totalWants + shortTermSavings + totalInsurance + totalInvestments - taxPayable;

  // Emergency-fund basis: what it costs to merely keep running for a month —
  // needs (spending) + loan EMIs (both in totalNeeds) + mandatory investments.
  const minimumMonthlyExpense = totalNeeds + mandatoryInvestments;
  const emergencyMultiplier = inputs.saving?.emergencyMultiplier ?? DEFAULT_EMERGENCY_MULTIPLIER;
  const emergencyTarget = minimumMonthlyExpense * emergencyMultiplier;

  // Monthly spend-allocation buckets:
  //  · Living  = needs + wants + mandatory investments (EPF/NPS)
  //  · Safety  = insurance + short-term (emergency) savings
  //  · Growth & Freedom = discretionary (voluntary) investments
  const living = totalNeeds + totalWants + mandatoryInvestments;
  const safety = totalInsurance + shortTermSavings;
  const growthFreedom = discretionaryInvestments;

  return {
    gross,
    annualGross,
    totalNeeds,
    totalWants,
    totalLoanEmis,
    totalInsurance,
    totalInvestments,
    shortTermSavings,
    tax,
    taxAnnual,
    taxPayable,
    netIncome,
    minimumIncome,
    surplus: netIncome - minimumIncome,
    minimumMonthlyExpense,
    emergencyMultiplier,
    emergencyTarget,
    mandatoryInvestments,
    discretionaryInvestments,
    allocation: {
      living,
      safety,
      growthFreedom,
      total: living + safety + growthFreedom,
    },
  };
}
