import { computed, effect, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { StorageService } from '../storage/storage.service';
import { FinanceStore } from './finance-store';
import {
  applyEdit,
  carryForward,
  DEFAULT_HISTORY,
  EMPTY_BREAKDOWN,
  HistoryState,
  isUserAuthored,
  latestBefore,
  MonthKey,
  MonthSnapshot,
  monthKey,
  previousMonthKey,
  snapshotFromDerived,
  sortedKeys,
  StartMode,
  fyStartKey,
} from './history.model';

/**
 * The app's month-by-month memory.
 *
 * `FinanceStore` describes one steady-state month; this store remembers what the
 * months actually were. It freezes a snapshot when the month turns over, and
 * otherwise stays out of the way — nothing here ever overwrites a figure the
 * user typed themselves.
 */
@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly store = inject(StorageService).bind<HistoryState>({
    key: 'finance-history',
    version: 1,
    defaults: DEFAULT_HISTORY,
  });
  private readonly finance = inject(FinanceStore);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly value = this.store.value;
  readonly ready = this.store.ready;
  readonly months = computed(() => this.value().months);
  readonly trackingStart = computed(() => this.value().trackingStart);
  readonly startMode = computed(() => this.value().startMode);
  /** True until the user has chosen where tracking begins. */
  readonly needsStartMode = computed(() => this.trackingStart() === null);
  /** Month keys that have a snapshot, oldest first. */
  readonly keys = computed(() => sortedKeys(this.value()));
  /** `[key, snapshot]` pairs, oldest first — what the tracker and charts iterate. */
  readonly entries = computed(() => this.keys().map((key) => [key, this.months()[key]] as const));

  constructor() {
    // Roll the previous month over once both stores have hydrated, then stop
    // listening. Guarded off the server: the build-time prerender has no
    // IndexedDB and must not invent a snapshot into the shipped HTML.
    if (!this.isBrowser) return;
    const rollover = effect(() => {
      if (!this.ready() || !this.finance.ready()) return;
      this.ensureCurrentMonth();
      rollover.destroy();
    });
  }

  /**
   * Bring history up to date with the calendar.
   *
   * Called once on load. If tracking has started and the month *before* the
   * current one has no snapshot, freeze one from the model as it stands now —
   * that is the closest thing to a record of the month that just ended. The
   * current month is left alone; it isn't over yet.
   *
   * Never touches a month the user authored, and never back-fills more than the
   * single previous month: gaps are the user's to fill deliberately, not
   * something to paper over with today's numbers.
   */
  ensureCurrentMonth(now: Date = new Date()): void {
    const state = this.value();
    if (state.trackingStart === null) return;

    const previous = previousMonthKey(monthKey(now));
    if (previous < state.trackingStart) return;
    if (state.months[previous]) return;

    const carried = latestBefore(state, previous);
    const snapshot = carried
      ? carryForward(carried)
      : snapshotFromDerived(this.finance.derived(), 'auto');
    this.writeMonth(previous, snapshot);
  }

  /**
   * Begin tracking. `'first-use'` starts at the current month, `'fy'` at April of
   * the current Indian financial year, `'custom'` wherever the caller says.
   * A no-op once tracking has already started — the start month is set once.
   */
  setStartMode(mode: StartMode, customStart?: MonthKey, now: Date = new Date()): void {
    const state = this.value();
    if (state.trackingStart !== null) return;

    const start = mode === 'fy' ? fyStartKey(now) : mode === 'custom' ? customStart : monthKey(now);
    if (!start) return;

    this.store.set({ ...state, startMode: mode, trackingStart: start });
  }

  /**
   * Edit one month. Whatever the caller passes becomes the user's word, so the
   * result is marked `'manual'` and rollover will never overwrite it again.
   * Unknown months are created from the carried-forward previous month, so an
   * edit to a single field doesn't wipe the rest.
   */
  setMonth(key: MonthKey, patch: Partial<Omit<MonthSnapshot, 'source' | 'expenses'>>): void {
    const state = this.value();
    const base = state.months[key] ?? this.blankFor(key);
    this.writeMonth(key, applyEdit(base, patch, 'manual'));
  }

  /**
   * Record a month that predates tracking. Marked `'backfill'` so the UI can say
   * where the figures came from; like `'manual'`, automation leaves it alone.
   * Also pulls `trackingStart` back if the backfilled month sits before it.
   */
  backfill(key: MonthKey, snapshot: Omit<MonthSnapshot, 'source' | 'expenses'>): void {
    const base = this.blankFor(key);
    const state = this.value();
    const trackingStart =
      state.trackingStart === null || key < state.trackingStart ? key : state.trackingStart;
    this.store.set({
      ...state,
      trackingStart,
      months: { ...state.months, [key]: applyEdit(base, snapshot, 'backfill') },
    });
  }

  /** Forget one month entirely. */
  removeMonth(key: MonthKey): void {
    this.store.update((state) => {
      if (!state.months[key]) return state;
      const months = { ...state.months };
      delete months[key];
      return { ...state, months };
    });
  }

  /** One month's snapshot, or undefined if it isn't tracked. */
  snapshot(key: MonthKey): MonthSnapshot | undefined {
    return this.months()[key];
  }

  /** True when this month's figures are still the previous month's, unedited. */
  isCarriedOver(key: MonthKey): boolean {
    return !isUserAuthored(this.months()[key]);
  }

  /**
   * What a not-yet-tracked month would be pre-filled with — the previous
   * month's figures if there are any, otherwise today's model. Used by the
   * tracker to show a suggestion before anything is committed.
   */
  suggestionFor(key: MonthKey): MonthSnapshot {
    return this.blankFor(key);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  async reset(): Promise<void> {
    await this.store.reset();
  }

  // ---- internals ----

  private blankFor(key: MonthKey): MonthSnapshot {
    const carried = latestBefore(this.value(), key);
    if (carried) return carryForward(carried);
    if (this.finance.ready()) return snapshotFromDerived(this.finance.derived(), 'auto');
    return { income: 0, expenses: 0, breakdown: { ...EMPTY_BREAKDOWN }, source: 'auto' };
  }

  private writeMonth(key: MonthKey, snapshot: MonthSnapshot): void {
    this.store.update((state) => ({
      ...state,
      months: { ...state.months, [key]: snapshot },
    }));
  }
}
