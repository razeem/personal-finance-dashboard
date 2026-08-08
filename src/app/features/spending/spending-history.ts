import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { InrPipe } from '../../shared/inr-pipe';
import { SectionCard } from '../../shared/ui/section-card/section-card';
import { StatTile } from '../../shared/ui/stat-tile/stat-tile';
import { HistoryStore } from '../../core/finance/history-store';
import {
  MonthBreakdown,
  MonthKey,
  MonthSnapshot,
  fyStartKey,
  monthKey,
  monthLabel,
  StartMode,
} from '../../core/finance/history.model';

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
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    SectionCard,
    StatTile,
  ],
  templateUrl: './spending-history.html',
})
export class SpendingHistory {
  private readonly history = inject(HistoryStore);

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
