import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { InrPipe } from '../../shared/inr-pipe';
import { SectionCard } from '../../shared/ui/section-card/section-card';
import { StatTile } from '../../shared/ui/stat-tile/stat-tile';
import { SparkChart } from '../../shared/ui/spark-chart/spark-chart';
import { Series } from '../../shared/ui/spark-chart/spark-chart.model';
import { HistoryStore } from '../../core/finance/history-store';
import {
  aggregateByFy,
  MonthBreakdown,
  MonthKey,
  MonthSnapshot,
  fyStartKey,
  monthKey,
  monthLabel,
  StartMode,
} from '../../core/finance/history.model';
import { PreferencesStore } from '../../core/preferences/preferences-store';
import { formatInr } from '../../shared/inr-pipe';

/** One month as the template needs it: the figures plus how they got there. */
interface MonthRow {
  key: MonthKey;
  label: string;
  snapshot: MonthSnapshot;
  /** True when nothing is stored for this month — the figures are a suggestion. */
  blank: boolean;
  /** True when the figures came from the previous month rather than the user. */
  carried: boolean;
}

/** The seven expense categories, in the order the tracker lists them. */
const CATEGORIES: readonly { key: keyof MonthBreakdown; label: string }[] = [
  { key: 'needs', label: 'Needs' },
  { key: 'wants', label: 'Wants' },
  { key: 'emis', label: 'Loan EMIs' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'investingMandatory', label: 'EPF / NPS' },
  { key: 'investingVoluntary', label: 'Investments' },
  { key: 'tax', label: 'Tax' },
];

/**
 * The month-by-month tracker.
 *
 * Reads and writes `HistoryStore` only — it has no state of its own beyond the
 * custom-start month being typed. Every month starts pre-filled by carrying the
 * previous one forward, marked as such until it's edited; the first edit makes
 * it the user's word and rollover leaves it alone from then on.
 */
@Component({
  selector: 'app-spending-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    InrPipe,
    MatButtonModule,
    MatButtonToggleModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    SectionCard,
    SparkChart,
    StatTile,
  ],
  templateUrl: './spending-history.html',
})
export class SpendingHistory {
  private readonly history = inject(HistoryStore);
  private readonly prefs = inject(PreferencesStore);

  protected readonly categories = CATEGORIES;
  protected readonly needsStartMode = this.history.needsStartMode;
  protected readonly startMode = this.history.startMode;
  protected readonly trackingStart = this.history.trackingStart;
  protected readonly trackingStartLabel = computed(() => monthLabel(this.trackingStart() ?? ''));

  /** The month typed into the "add an earlier month" field, as `YYYY-MM`. */
  protected readonly customStart = signal(monthKey(new Date()));
  protected readonly backfillMonth = signal('');

  /** What each start mode would begin at, so the picker can say so up front. */
  protected readonly thisMonthLabel = computed(() => monthLabel(monthKey(new Date())));
  protected readonly fyStartLabel = computed(() => monthLabel(fyStartKey(new Date())));

  /** Newest month first — the one you are most likely to be filling in. */
  protected readonly rows = computed<MonthRow[]>(() =>
    this.history
      .trackedRange()
      .map((key) => {
        const stored = this.history.snapshot(key);
        return {
          key,
          label: monthLabel(key),
          snapshot: stored ?? this.history.suggestionFor(key),
          blank: !stored,
          carried: !stored || this.history.isCarriedOver(key),
        };
      })
      .reverse(),
  );

  /** Months actually recorded — the denominator for "you've tracked N months". */
  protected readonly recordedCount = computed(() => this.history.keys().length);

  protected readonly totalIncome = computed(() =>
    this.history.entries().reduce((sum, [, snapshot]) => sum + snapshot.income, 0),
  );
  protected readonly totalExpenses = computed(() =>
    this.history.entries().reduce((sum, [, snapshot]) => sum + snapshot.expenses, 0),
  );
  protected readonly totalSaved = computed(() => this.totalIncome() - this.totalExpenses());

  // ---- Trends -------------------------------------------------------------

  /** Monthly or financial-year granularity for both charts. */
  protected readonly grain = signal<'month' | 'fy'>('month');

  private readonly fyTotals = computed(() => aggregateByFy(this.history.value()));

  /** Only recorded months feed the charts — blanks would read as real zeroes. */
  private readonly points = computed(() =>
    this.grain() === 'fy'
      ? this.fyTotals().map((fy) => ({
          label: fy.label,
          income: fy.income,
          expenses: fy.expenses,
          breakdown: fy.breakdown,
        }))
      : this.history.entries().map(([key, snapshot]) => ({
          label: monthLabel(key),
          income: snapshot.income,
          expenses: snapshot.expenses,
          breakdown: snapshot.breakdown,
        })),
  );

  protected readonly chartLabels = computed(() => this.points().map((p) => p.label));
  /** Charts need at least two points before a "trend" means anything. */
  protected readonly hasTrend = computed(() => this.points().length >= 2);

  protected readonly incomeVsExpenses = computed<Series[]>(() => [
    { label: 'Income', values: this.points().map((p) => p.income) },
    { label: 'Spent', values: this.points().map((p) => p.expenses) },
  ]);

  protected readonly breakdownSeries = computed<Series[]>(() =>
    CATEGORIES.map((category) => ({
      label: category.label,
      values: this.points().map((p) => p.breakdown[category.key]),
    })),
  );

  /** Compact rupee labels for the value axis — ₹1.2L beats ₹1,20,000 on an axis. */
  protected readonly formatAxis = computed(() => {
    const mode = this.prefs.numberFormat();
    return (value: number): string => {
      const abs = Math.abs(value);
      if (mode === 'indian') {
        if (abs >= 10_000_000) return `₹${trim(value / 10_000_000)}Cr`;
        if (abs >= 100_000) return `₹${trim(value / 100_000)}L`;
        if (abs >= 1_000) return `₹${trim(value / 1_000)}k`;
      } else {
        if (abs >= 1_000_000) return `₹${trim(value / 1_000_000)}M`;
        if (abs >= 1_000) return `₹${trim(value / 1_000)}k`;
      }
      return formatInr(value, mode);
    };
  });

  protected start(mode: StartMode): void {
    this.history.setStartMode(mode, mode === 'custom' ? this.customStart() : undefined);
  }

  protected setIncome(key: MonthKey, value: string | number): void {
    this.history.setMonth(key, { income: toAmount(value) });
  }

  protected setExpenses(key: MonthKey, value: string | number): void {
    this.history.setMonthExpenses(key, toAmount(value));
  }

  protected setCategory(
    key: MonthKey,
    category: keyof MonthBreakdown,
    value: string | number,
  ): void {
    this.history.setMonthCategory(key, category, toAmount(value));
  }

  protected saved(row: MonthRow): number {
    return row.snapshot.income - row.snapshot.expenses;
  }

  /** Add a month before the tracking start, from the "earlier month" field. */
  protected addEarlier(): void {
    const key = this.backfillMonth();
    if (!/^\d{4}-\d{2}$/.test(key)) return;
    const suggestion = this.history.suggestionFor(key);
    this.history.backfill(key, { income: suggestion.income, breakdown: suggestion.breakdown });
    this.backfillMonth.set('');
  }

  protected remove(key: MonthKey): void {
    this.history.removeMonth(key);
  }
}

function toAmount(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** One decimal, but only when it says something: 1.5L, not 2.0L. */
function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
