import { signal, Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, vi } from 'vitest';
import { CollectionConfig, PersistentCollection, StorageService } from '../storage/storage.service';
import { HistoryStore } from './history-store';
import { HistoryState, MonthSnapshot, monthKey, previousMonthKey } from './history.model';

/**
 * In-memory stand-in for StorageService. IndexedDB does not exist under jsdom,
 * and these tests are about the store's *rules* (when a month is frozen, what is
 * safe to overwrite), not about persistence — which storage.service.ts owns.
 */
class MemoryStorage {
  /** Pre-seeded documents, keyed by collection key, as if already hydrated. */
  readonly seed: Record<string, unknown> = {};

  bind<T>(config: CollectionConfig<T>): PersistentCollection<T> {
    const seeded = this.seed[config.key] as T | undefined;
    const value = signal<T>(seeded ?? config.defaults);
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

const NOW = new Date(2026, 6, 12); // 12 July 2026
const THIS_MONTH = monthKey(NOW); // 2026-07
const LAST_MONTH = previousMonthKey(THIS_MONTH); // 2026-06

function snapshot(income: number, source: MonthSnapshot['source'] = 'manual'): MonthSnapshot {
  return {
    income,
    expenses: 10,
    breakdown: {
      needs: 10,
      wants: 0,
      insurance: 0,
      investingMandatory: 0,
      investingVoluntary: 0,
      emis: 0,
      tax: 0,
    },
    source,
  };
}

// The store's constructor rolls the calendar over on its own, reading the real
// clock. Pin the clock so those tests describe a fixed month, not "today".
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function makeStore(seed?: Partial<HistoryState>): HistoryStore {
  const storage = new MemoryStorage();
  if (seed) {
    storage.seed['finance-history'] = {
      months: {},
      trackingStart: null,
      startMode: 'first-use',
      ...seed,
    };
  }
  TestBed.configureTestingModule({
    providers: [{ provide: StorageService, useValue: storage }],
  });
  const store = TestBed.inject(HistoryStore);
  TestBed.tick(); // let the constructor's rollover effect run
  return store;
}

describe('HistoryStore · start mode', () => {
  it('asks for a start mode until one is chosen', () => {
    const store = makeStore();
    expect(store.needsStartMode()).toBe(true);
    expect(store.trackingStart()).toBeNull();
  });

  it("'first-use' starts tracking at the current month", () => {
    const store = makeStore();
    store.setStartMode('first-use', undefined, NOW);
    expect(store.trackingStart()).toBe('2026-07');
    expect(store.needsStartMode()).toBe(false);
  });

  it("'fy' starts tracking at April of the current Indian FY", () => {
    const store = makeStore();
    store.setStartMode('fy', undefined, NOW);
    expect(store.trackingStart()).toBe('2026-04');
  });

  it("'custom' starts wherever the user says", () => {
    const store = makeStore();
    store.setStartMode('custom', '2024-11', NOW);
    expect(store.trackingStart()).toBe('2024-11');
    expect(store.startMode()).toBe('custom');
  });

  it('ignores a custom mode with no month rather than guessing', () => {
    const store = makeStore();
    store.setStartMode('custom', undefined, NOW);
    expect(store.trackingStart()).toBeNull();
  });

  it('is set once — a later call cannot move the start month', () => {
    const store = makeStore();
    store.setStartMode('first-use', undefined, NOW);
    store.setStartMode('fy', undefined, NOW);
    expect(store.trackingStart()).toBe('2026-07');
  });
});

describe('HistoryStore · rollover', () => {
  it('does nothing at all before tracking has started', () => {
    const store = makeStore();
    store.ensureCurrentMonth(NOW);
    expect(store.keys()).toEqual([]);
  });

  it('freezes the previous month once tracking has started', () => {
    const store = makeStore({ trackingStart: '2026-01' });
    store.ensureCurrentMonth(NOW);
    expect(store.keys()).toEqual([LAST_MONTH]);
    expect(store.snapshot(LAST_MONTH)?.source).toBe('auto');
  });

  it('leaves the current month alone — it is not over yet', () => {
    const store = makeStore({ trackingStart: '2026-01' });
    store.ensureCurrentMonth(NOW);
    expect(store.snapshot(THIS_MONTH)).toBeUndefined();
  });

  it('carries the previous month forward rather than re-reading the model', () => {
    const store = makeStore({
      trackingStart: '2026-01',
      months: { '2026-05': snapshot(77_777) },
    });
    store.ensureCurrentMonth(NOW);
    expect(store.snapshot(LAST_MONTH)?.income).toBe(77_777);
    expect(store.snapshot(LAST_MONTH)?.source).toBe('auto');
  });

  it('never overwrites a month the user typed', () => {
    const store = makeStore({
      trackingStart: '2026-01',
      months: { [LAST_MONTH]: snapshot(12_345, 'manual') },
    });
    store.ensureCurrentMonth(NOW);
    expect(store.snapshot(LAST_MONTH)?.income).toBe(12_345);
    expect(store.snapshot(LAST_MONTH)?.source).toBe('manual');
  });

  it('never overwrites a backfilled month either', () => {
    const store = makeStore({
      trackingStart: '2026-01',
      months: { [LAST_MONTH]: snapshot(999, 'backfill') },
    });
    store.ensureCurrentMonth(NOW);
    expect(store.snapshot(LAST_MONTH)?.source).toBe('backfill');
  });

  it('is idempotent — running it twice does not double up or churn', () => {
    const store = makeStore({ trackingStart: '2026-01' });
    store.ensureCurrentMonth(NOW);
    const first = store.snapshot(LAST_MONTH);
    store.ensureCurrentMonth(NOW);
    expect(store.keys()).toHaveLength(1);
    expect(store.snapshot(LAST_MONTH)).toBe(first); // same object: no rewrite
  });

  it('does not reach back before the tracking start', () => {
    const store = makeStore({ trackingStart: '2026-12' });
    store.ensureCurrentMonth(NOW); // previous month is 2026-06, before the start
    expect(store.keys()).toEqual([]);
  });

  it('fills only the single previous month, not every gap since the start', () => {
    const store = makeStore({
      trackingStart: '2026-01',
      months: { '2026-01': snapshot(1) },
    });
    store.ensureCurrentMonth(NOW);
    // Feb–May stay absent: gaps are the user's to fill deliberately.
    expect(store.keys()).toEqual(['2026-01', LAST_MONTH]);
  });
});

describe('HistoryStore · editing', () => {
  it('marks an edited month manual and re-derives its expenses', () => {
    const store = makeStore({ trackingStart: '2026-01', months: { '2026-05': snapshot(1) } });
    store.setMonth('2026-05', {
      income: 60_000,
      breakdown: { ...snapshot(1).breakdown, wants: 5 },
    });

    const edited = store.snapshot('2026-05')!;
    expect(edited.income).toBe(60_000);
    expect(edited.expenses).toBe(15); // needs 10 + wants 5
    expect(edited.source).toBe('manual');
    expect(store.isCarriedOver('2026-05')).toBe(false);
  });

  it('creates an unknown month from the carried-forward previous one', () => {
    const store = makeStore({ trackingStart: '2026-01', months: { '2026-02': snapshot(42) } });
    store.setMonth('2026-06', { income: 50 });

    const created = store.snapshot('2026-06')!;
    expect(created.income).toBe(50);
    // The rest came from February, not from zero.
    expect(created.breakdown.needs).toBe(10);
  });

  it('reports a rolled-over month as carried until it is edited', () => {
    const store = makeStore({ trackingStart: '2026-01' });
    store.ensureCurrentMonth(NOW);
    expect(store.isCarriedOver(LAST_MONTH)).toBe(true);
    store.setMonth(LAST_MONTH, { income: 1 });
    expect(store.isCarriedOver(LAST_MONTH)).toBe(false);
  });

  it('backfills a pre-tracking month and pulls the start date back with it', () => {
    const store = makeStore({ trackingStart: '2026-06' });
    store.backfill('2025-09', { income: 40_000, breakdown: snapshot(0).breakdown });

    expect(store.snapshot('2025-09')?.source).toBe('backfill');
    expect(store.snapshot('2025-09')?.income).toBe(40_000);
    expect(store.trackingStart()).toBe('2025-09');
  });

  it('leaves the start date alone when backfilling inside the tracked range', () => {
    const store = makeStore({ trackingStart: '2026-01' });
    store.backfill('2026-03', { income: 1, breakdown: snapshot(0).breakdown });
    expect(store.trackingStart()).toBe('2026-01');
  });

  it('forgets a month on request', () => {
    const store = makeStore({ trackingStart: '2026-01', months: { '2026-02': snapshot(1) } });
    store.removeMonth('2026-02');
    expect(store.snapshot('2026-02')).toBeUndefined();
    // Only the month the constructor rolled over survives.
    expect(store.keys()).toEqual([LAST_MONTH]);
  });

  it('exposes entries oldest first', () => {
    const store = makeStore({
      trackingStart: '2026-01',
      months: { '2026-03': snapshot(3), '2026-01': snapshot(1), '2026-02': snapshot(2) },
    });
    // …including LAST_MONTH, frozen by the constructor's rollover.
    expect(store.entries().map(([key]) => key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      LAST_MONTH,
    ]);
  });
});
