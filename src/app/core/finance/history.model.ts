import { DerivedFinance } from './finance.model';

/**
 * Month history — the app's memory of what each month actually looked like.
 *
 * The design decision baked in here: a month is a **snapshot of the shared
 * model**, not a transaction ledger. The declaration pillars already describe
 * one steady-state month; history simply freezes that description each time the
 * month turns over, so trends fall out without asking anyone to book entries.
 *
 * Storage is one document holding a **sparse map keyed `YYYY-MM`** — months with
 * nothing to say are simply absent, which is also what makes a flexible start
 * (first use / current FY / arbitrary backfill) a setting rather than a third
 * data model.
 *
 * Everything in this file is pure and unit-tested; `history-store.ts` is the only
 * thing that knows about Angular or IndexedDB.
 */

/** A month, `YYYY-MM` (e.g. `2026-04`). Sorts correctly as a plain string. */
export type MonthKey = string;

/** Where a snapshot's numbers came from — decides whether they can be overwritten. */
export type SnapshotSource =
  /** Frozen automatically at month rollover from the then-current derived model. */
  | 'auto'
  /** Typed (or corrected) by the user. Never overwritten by automation. */
  | 'manual'
  /** Entered for a month that predates tracking. Also user-authored. */
  | 'backfill';

/** The expense side of a month, split the way the pillars own it. */
export interface MonthBreakdown {
  needs: number;
  wants: number;
  insurance: number;
  investingMandatory: number;
  investingVoluntary: number;
  emis: number;
  tax: number;
}

export interface MonthSnapshot {
  /** Money in, for the month. */
  income: number;
  /** Money out, for the month — the sum of `breakdown`. */
  expenses: number;
  breakdown: MonthBreakdown;
  source: SnapshotSource;
}

export const EMPTY_BREAKDOWN: MonthBreakdown = {
  needs: 0,
  wants: 0,
  insurance: 0,
  investingMandatory: 0,
  investingVoluntary: 0,
  emis: 0,
  tax: 0,
};

/** How the user chose to start tracking (only asked once). */
export type StartMode =
  /** Begin at the month they first opened the tracker. */
  | 'first-use'
  /** Begin at April of the current Indian financial year. */
  | 'fy'
  /** Begin wherever they say — any past month can be added. */
  | 'custom';

export interface HistoryState {
  /** Sparse: only months that have a snapshot appear. */
  months: Record<MonthKey, MonthSnapshot>;
  /** The month tracking began, or null until the user picks a start mode. */
  trackingStart: MonthKey | null;
  startMode: StartMode;
}

export const DEFAULT_HISTORY: HistoryState = {
  months: {},
  trackingStart: null,
  startMode: 'first-use',
};

// --- Keys and the Indian financial year ------------------------------------

/** `YYYY-MM` for a date, in local time (the user's own calendar, not UTC). */
export function monthKey(date: Date): MonthKey {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Parse `YYYY-MM` back into a Date at midnight on the 1st, or null if malformed. */
export function parseMonthKey(key: MonthKey): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
}

/** Move a month key forward (or back, with a negative delta) by whole months. */
export function shiftMonthKey(key: MonthKey, delta: number): MonthKey {
  const date = parseMonthKey(key);
  if (!date) return key;
  date.setMonth(date.getMonth() + delta);
  return monthKey(date);
}

/** The month before `key`. */
export function previousMonthKey(key: MonthKey): MonthKey {
  return shiftMonthKey(key, -1);
}

/**
 * Every month of the Indian financial year containing `date`, April → March.
 * FY 2026-27 runs 2026-04 … 2027-03, so a January date belongs to the FY that
 * started the previous April.
 */
export function fyKeyRange(date: Date): MonthKey[] {
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return Array.from({ length: 12 }, (_, i) => shiftMonthKey(`${startYear}-04`, i));
}

/** April of the financial year containing `date` — the `'fy'` start month. */
export function fyStartKey(date: Date): MonthKey {
  return fyKeyRange(date)[0];
}

/** Human label for a month key, e.g. `2026-04` → `Apr 2026`. Falls back to the key. */
export function monthLabel(key: MonthKey): string {
  const date = parseMonthKey(key);
  if (!date) return key;
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Every month from `from` to `to` inclusive, ascending. Returns `[]` if either
 * key is malformed or the range runs backwards.
 */
export function monthKeyRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const start = parseMonthKey(from);
  const end = parseMonthKey(to);
  if (!start || !end || start > end) return [];
  const keys: MonthKey[] = [];
  for (let k = from; k <= to; k = shiftMonthKey(k, 1)) keys.push(k);
  return keys;
}

// --- Snapshots --------------------------------------------------------------

/** Sum a breakdown into the single `expenses` figure. */
export function sumBreakdown(breakdown: MonthBreakdown): number {
  return (
    breakdown.needs +
    breakdown.wants +
    breakdown.insurance +
    breakdown.investingMandatory +
    breakdown.investingVoluntary +
    breakdown.emis +
    breakdown.tax
  );
}

/**
 * Freeze the current shared model into a month snapshot.
 *
 * Two things worth knowing about the shape of the result:
 *
 * - `derived.totalNeeds` already rolls loan EMIs in, so EMIs are pulled back out
 *   here. The breakdown has to be a *partition* of `expenses`, or the stacked
 *   chart and the total would double-count them.
 * - Short-term savings are deliberately **not** an expense. Income minus
 *   expenses is what the month actually put aside, which is the number a trend
 *   line should show.
 *
 * Income is the declared typical monthly gross. A month that was unusual (a
 * bonus, a hike mid-month) is exactly what the tracker's per-month edit is for.
 */
export function snapshotFromDerived(
  derived: DerivedFinance,
  source: SnapshotSource = 'auto',
): MonthSnapshot {
  const breakdown: MonthBreakdown = {
    needs: round2(derived.totalNeeds - derived.totalLoanEmis),
    wants: round2(derived.totalWants),
    insurance: round2(derived.totalInsurance),
    investingMandatory: round2(derived.mandatoryInvestments),
    investingVoluntary: round2(derived.discretionaryInvestments),
    emis: round2(derived.totalLoanEmis),
    tax: round2(derived.taxPayable),
  };
  return {
    income: round2(derived.gross),
    expenses: round2(sumBreakdown(breakdown)),
    breakdown,
    source,
  };
}

/**
 * Repeat a month forward as the starting point for the next one.
 *
 * The result is deliberately marked `'auto'` however it was produced: it is a
 * *suggestion* carried over from the previous month, not something anyone has
 * confirmed, and the tracker shows it as "carried over" until it's edited.
 */
export function carryForward(previous: MonthSnapshot): MonthSnapshot {
  return {
    income: previous.income,
    expenses: previous.expenses,
    breakdown: { ...previous.breakdown },
    source: 'auto',
  };
}

/** True when a snapshot is the user's own word and must never be overwritten. */
export function isUserAuthored(snapshot: MonthSnapshot | undefined): boolean {
  return snapshot?.source === 'manual' || snapshot?.source === 'backfill';
}

/**
 * Apply a partial edit to a month, re-deriving `expenses` from the breakdown so
 * the two can never drift apart. Any edit is the user's word, hence `'manual'`
 * unless the caller says otherwise (backfilling a pre-tracking month).
 */
export function applyEdit(
  base: MonthSnapshot,
  patch: Partial<Omit<MonthSnapshot, 'source' | 'expenses'>>,
  source: SnapshotSource = 'manual',
): MonthSnapshot {
  const breakdown = { ...base.breakdown, ...(patch.breakdown ?? {}) };
  return {
    income: round2(patch.income ?? base.income),
    expenses: round2(sumBreakdown(breakdown)),
    breakdown,
    source,
  };
}

/**
 * Re-scale a breakdown so it sums to `total`, keeping the category proportions.
 *
 * This is what lets the tracker offer a single "what did this month actually
 * cost?" field without either abandoning the breakdown or making the user retype
 * seven numbers: the split they already declared is treated as an estimate of
 * the *shape* of their spending, and only its size is corrected.
 *
 * When the current breakdown is empty there are no proportions to keep, so the
 * whole amount lands in `needs` — the catch-all essential bucket — for the user
 * to split up later.
 */
export function scaleBreakdownTo(breakdown: MonthBreakdown, total: number): MonthBreakdown {
  const target = Math.max(0, Number.isFinite(total) ? total : 0);
  const current = sumBreakdown(breakdown);
  if (current <= 0) return { ...EMPTY_BREAKDOWN, needs: round2(target) };

  const factor = target / current;
  const scaled: MonthBreakdown = {
    needs: round2(breakdown.needs * factor),
    wants: round2(breakdown.wants * factor),
    insurance: round2(breakdown.insurance * factor),
    investingMandatory: round2(breakdown.investingMandatory * factor),
    investingVoluntary: round2(breakdown.investingVoluntary * factor),
    emis: round2(breakdown.emis * factor),
    tax: round2(breakdown.tax * factor),
  };
  // Rounding seven categories can miss the target by a paisa or two; absorb the
  // remainder into needs so `sumBreakdown` still returns exactly `total`.
  return { ...scaled, needs: round2(scaled.needs + (target - sumBreakdown(scaled))) };
}

/**
 * One financial year's worth of months, summed. `key` is the FY's April month so
 * it sorts chronologically; `label` is how it's written down in India.
 */
export interface FyTotals {
  key: MonthKey;
  label: string;
  income: number;
  expenses: number;
  breakdown: MonthBreakdown;
  /** How many months of the year actually have a snapshot. */
  monthCount: number;
}

/** `FY 2026-27` for any month inside that financial year. */
export function fyLabelOf(key: MonthKey): string {
  const date = parseMonthKey(key);
  if (!date) return key;
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Roll month snapshots up into Indian financial years, oldest first.
 *
 * Buckets come from `fyKeyRange`, so a year is defined by the same Apr→Mar
 * window the rest of the app uses rather than by whatever months happen to be
 * present. Partial years are included with their real `monthCount` — a year with
 * three months tracked is honestly three months of spending, not a shortfall.
 */
export function aggregateByFy(state: HistoryState): FyTotals[] {
  const byYear = new Map<MonthKey, FyTotals>();

  for (const key of sortedKeys(state)) {
    const date = parseMonthKey(key);
    if (!date) continue;
    const fyKey = fyKeyRange(date)[0];
    const totals =
      byYear.get(fyKey) ??
      ({
        key: fyKey,
        label: fyLabelOf(key),
        income: 0,
        expenses: 0,
        breakdown: { ...EMPTY_BREAKDOWN },
        monthCount: 0,
      } satisfies FyTotals);

    const snapshot = state.months[key];
    totals.income = round2(totals.income + snapshot.income);
    totals.expenses = round2(totals.expenses + snapshot.expenses);
    for (const category of Object.keys(EMPTY_BREAKDOWN) as (keyof MonthBreakdown)[]) {
      totals.breakdown[category] = round2(
        totals.breakdown[category] + (snapshot.breakdown[category] ?? 0),
      );
    }
    totals.monthCount += 1;
    byYear.set(fyKey, totals);
  }

  return [...byYear.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Month keys present in `state`, ascending. */
export function sortedKeys(state: HistoryState): MonthKey[] {
  return Object.keys(state.months).sort();
}

/**
 * The snapshot to carry into `key`: the nearest earlier month that has one.
 * Returns null when nothing precedes it (the very first tracked month).
 */
export function latestBefore(state: HistoryState, key: MonthKey): MonthSnapshot | null {
  const earlier = sortedKeys(state).filter((k) => k < key);
  const nearest = earlier[earlier.length - 1];
  return nearest ? state.months[nearest] : null;
}

/** Round to whole paise — enough precision for rupees, no floating-point noise. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
