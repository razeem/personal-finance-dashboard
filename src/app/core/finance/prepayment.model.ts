import { MonthKey, shiftMonthKey } from './history.model';

/**
 * Pure debt-free forecasting: what happens to a loan if you throw more at it.
 *
 * Extends the amortization idea in `emi.model.ts` rather than replacing it —
 * same reducing-balance arithmetic, same monthly units — but runs it forwards
 * from an **outstanding balance** rather than from an original principal, which
 * is what you actually know about a loan you are halfway through.
 *
 * The rule throughout: **prepayments shorten the tenure, they do not lower the
 * instalment.** That is what makes them worth doing, and it is what every bank
 * in India defaults to. The one exception is the step-up strategy, whose whole
 * point is to raise the instalment on purpose.
 *
 * No Angular, no clock — the caller passes the month to count from.
 */

export interface LoanPosition {
  /** Outstanding balance today. */
  principal: number;
  /** Nominal annual interest rate as a percentage (0 is valid). */
  annualRatePct: number;
  /** The monthly instalment. */
  emi: number;
}

/** Pay exactly what the bank asks, and nothing more. The comparison baseline. */
export interface BaselineStrategy {
  kind: 'baseline';
}

/**
 * Raise the instalment once a year — the "my salary went up, so should my EMI"
 * strategy. Give either a percentage of the current instalment or a flat amount.
 */
export interface StepUpStrategy {
  kind: 'stepUp';
  /** Percent to raise the instalment by each year, compounding. */
  pct?: number;
  /** Flat amount to add to the instalment each year. */
  amount?: number;
}

/** Throw a windfall at the balance — once, or every year. */
export interface LumpSumStrategy {
  kind: 'lumpSum';
  amount: number;
  /** Repeat every 12 months (an annual bonus) rather than paying once. */
  yearly: boolean;
  /** Months from now for a one-off payment. Ignored when `yearly`. */
  afterMonths?: number;
}

export type PrepaymentStrategy = BaselineStrategy | StepUpStrategy | LumpSumStrategy;

export interface ForecastRow {
  /** 1-based month index from the forecast's starting month. */
  month: number;
  /** The instalment due this month (rises under a step-up). */
  emi: number;
  /** Anything paid on top of the instalment. */
  extra: number;
  interest: number;
  /** Balance actually cleared this month — instalment principal plus extra. */
  principal: number;
  balance: number;
}

export interface Forecast {
  /** Months until the balance reaches zero. */
  months: number;
  /** The month the last rupee is paid, as `YYYY-MM`. */
  debtFreeMonth: MonthKey;
  totalInterest: number;
  /** Everything handed over — instalments plus prepayments. */
  totalPaid: number;
  schedule: ForecastRow[];
  /**
   * True when the loan never clears inside `MAX_MONTHS` — an instalment at or
   * below the monthly interest never touches the balance. The other figures then
   * describe the truncated run, not a real payoff.
   */
  neverPaysOff: boolean;
}

/** 50 years. Past this a "forecast" is not telling anyone anything useful. */
export const MAX_MONTHS = 600;

const EMPTY: Forecast = {
  months: 0,
  debtFreeMonth: '',
  totalInterest: 0,
  totalPaid: 0,
  schedule: [],
  neverPaysOff: false,
};

/**
 * Run a loan forward under one strategy.
 *
 * `fromMonth` is the month the forecast starts, as `YYYY-MM`; every date in the
 * result is derived from it, so the function stays pure and reproducible.
 */
export function forecast(
  loan: LoanPosition,
  strategy: PrepaymentStrategy,
  fromMonth: MonthKey,
): Forecast {
  const startBalance = numeric(loan.principal);
  const baseEmi = numeric(loan.emi);
  const monthlyRate = numeric(loan.annualRatePct) / 12 / 100;

  if (startBalance <= 0 || baseEmi <= 0) {
    return { ...EMPTY, debtFreeMonth: fromMonth };
  }

  const schedule: ForecastRow[] = [];
  let balance = startBalance;
  let emi = baseEmi;
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;

  while (balance > 0 && month < MAX_MONTHS) {
    month += 1;

    // A step-up lands at the start of each anniversary month: 13, 25, 37…
    if (strategy.kind === 'stepUp' && month > 1 && (month - 1) % 12 === 0) {
      emi = round2(emi + stepUpIncrement(emi, strategy));
    }

    const interest = round2(balance * monthlyRate);
    // Never collect more than the loan is worth: the final instalment is
    // whatever is actually left plus that month's interest.
    const due = Math.min(emi, round2(balance + interest));
    const fromInstalment = round2(due - interest);

    let balanceAfter = round2(balance - fromInstalment);
    const extra = balanceAfter > 0 ? Math.min(lumpSumFor(strategy, month), balanceAfter) : 0;
    balanceAfter = round2(balanceAfter - extra);

    totalInterest = round2(totalInterest + interest);
    totalPaid = round2(totalPaid + due + extra);

    schedule.push({
      month,
      emi: due,
      extra,
      interest,
      principal: round2(fromInstalment + extra),
      balance: balanceAfter < 0 ? 0 : balanceAfter,
    });

    // An instalment that does not even cover the interest will never clear the
    // loan; bail out rather than grinding to MAX_MONTHS.
    if (balanceAfter >= balance && extra === 0 && strategy.kind !== 'stepUp') {
      return {
        months: month,
        debtFreeMonth: shiftMonthKey(fromMonth, month - 1),
        totalInterest,
        totalPaid,
        schedule,
        neverPaysOff: true,
      };
    }

    balance = balanceAfter;
  }

  return {
    months: month,
    debtFreeMonth: shiftMonthKey(fromMonth, Math.max(0, month - 1)),
    totalInterest,
    totalPaid,
    schedule,
    neverPaysOff: balance > 0,
  };
}

/** How much the instalment rises on an anniversary. */
function stepUpIncrement(currentEmi: number, strategy: StepUpStrategy): number {
  if (strategy.pct !== undefined && Number.isFinite(strategy.pct)) {
    return (currentEmi * Math.max(0, strategy.pct)) / 100;
  }
  return Math.max(0, numeric(strategy.amount ?? 0));
}

/** The prepayment due in a given month, if any. */
function lumpSumFor(strategy: PrepaymentStrategy, month: number): number {
  if (strategy.kind !== 'lumpSum') return 0;
  const amount = numeric(strategy.amount);
  if (amount <= 0) return 0;
  if (strategy.yearly) return month % 12 === 0 ? amount : 0;
  return month === Math.max(1, (strategy.afterMonths ?? 0) + 1) ? amount : 0;
}

export interface StrategyComparison {
  label: string;
  strategy: PrepaymentStrategy;
  forecast: Forecast;
  /** Interest avoided versus the baseline. Zero for the baseline itself. */
  interestSaved: number;
  /** Months knocked off the baseline tenure. */
  monthsSaved: number;
}

/**
 * Run several strategies against the same loan and express each as a saving
 * relative to paying the bank exactly what it asks.
 *
 * The baseline is always first in the result, and is always the thing the others
 * are measured against — comparing two prepayment plans to each other rather
 * than to doing nothing tends to flatter both.
 */
export function compareStrategies(
  loan: LoanPosition,
  strategies: readonly { label: string; strategy: PrepaymentStrategy }[],
  fromMonth: MonthKey,
): StrategyComparison[] {
  const baseline = forecast(loan, { kind: 'baseline' }, fromMonth);

  return [
    {
      label: 'Baseline',
      strategy: { kind: 'baseline' } as PrepaymentStrategy,
      forecast: baseline,
      interestSaved: 0,
      monthsSaved: 0,
    },
    ...strategies.map(({ label, strategy }) => {
      const result = forecast(loan, strategy, fromMonth);
      return {
        label,
        strategy,
        forecast: result,
        interestSaved: round2(baseline.totalInterest - result.totalInterest),
        monthsSaved: baseline.months - result.months,
      };
    }),
  ];
}

/** Balance at the end of each month, padded so every curve spans the same axis. */
export function balanceCurve(result: Forecast, length: number): number[] {
  return Array.from({ length }, (_, i) => result.schedule[i]?.balance ?? 0);
}

function numeric(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
