import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { InrPipe } from '../../shared/inr-pipe';
import { SectionCard } from '../../shared/ui/section-card/section-card';
import { SliderField } from '../../shared/ui/slider-field/slider-field';
import { SparkChart } from '../../shared/ui/spark-chart/spark-chart';
import { Series } from '../../shared/ui/spark-chart/spark-chart.model';
import { FinanceStore } from '../../core/finance/finance-store';
import { HistoryStore } from '../../core/finance/history-store';
import { Loan, LoanGap, loanGaps, monthlyEmi } from '../../core/finance/finance.model';
import { monthKey, monthLabel } from '../../core/finance/history.model';
import {
  balanceCurve,
  compareStrategies,
  PrepaymentStrategy,
  StrategyComparison,
} from '../../core/finance/prepayment.model';
import { PreferencesStore } from '../../core/preferences/preferences-store';
import { formatInr } from '../../shared/inr-pipe';

/** How many months of history to average the surplus over. One month is noise. */
const SURPLUS_MONTHS = 3;

/** What each gap tells the user to go and do. */
const GAP_PROMPTS: Record<LoanGap, string> = {
  emi: 'an instalment amount',
  principal: 'the balance still outstanding',
  rate: 'the interest rate',
  billedYearly: 'a monthly instalment (it is billed yearly)',
};

@Component({
  selector: 'app-loan-forecast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    InrPipe,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    RouterLink,
    SectionCard,
    SliderField,
    SparkChart,
  ],
  templateUrl: './loan-forecast.html',
})
export class LoanForecast {
  private readonly finance = inject(FinanceStore);
  private readonly history = inject(HistoryStore);
  private readonly prefs = inject(PreferencesStore);

  protected readonly STEP_UP = { min: 0, max: 25, step: 1 };
  protected readonly LUMP = { min: 0, max: 500_000, step: 5_000 };

  // Scratch inputs — local signals, not persisted (a forecast is a scratchpad).
  protected readonly selectedId = signal<string | null>(null);
  protected readonly stepUpPct = signal(10);
  protected readonly lumpSum = signal(50_000);

  protected readonly allLoans = computed(() => this.finance.inputs().loan.loans);
  protected readonly ready = computed(() =>
    this.allLoans().filter((l) => loanGaps(l).length === 0),
  );
  protected readonly incomplete = computed(() =>
    this.allLoans().filter((l) => loanGaps(l).length > 0),
  );

  /** The loan being forecast — the chosen one, or the first that is ready. */
  protected readonly selected = computed<Loan | null>(() => {
    const ready = this.ready();
    const chosen = ready.find((l) => l.id === this.selectedId());
    return chosen ?? ready[0] ?? null;
  });

  /** Money left over in a typical recent month — what a prepayment comes out of. */
  protected readonly recentSurplus = computed(() => {
    const entries = this.history.entries().slice(-SURPLUS_MONTHS);
    if (!entries.length) return 0;
    const total = entries.reduce((sum, [, snap]) => sum + (snap.income - snap.expenses), 0);
    return Math.max(0, Math.round(total / entries.length));
  });
  protected readonly surplusMonths = computed(
    () => this.history.entries().slice(-SURPLUS_MONTHS).length,
  );

  protected readonly comparison = computed<StrategyComparison[]>(() => {
    const loan = this.selected();
    if (!loan) return [];
    return compareStrategies(
      {
        principal: loan.principal ?? 0,
        annualRatePct: loan.annualRatePct ?? 0,
        emi: monthlyEmi(loan),
      },
      [
        {
          label: `Step up ${this.stepUpPct()}%/yr`,
          strategy: { kind: 'stepUp', pct: this.stepUpPct() } as PrepaymentStrategy,
        },
        {
          label: `Prepay ${formatInr(this.lumpSum(), this.prefs.numberFormat())}/yr`,
          strategy: {
            kind: 'lumpSum',
            amount: this.lumpSum(),
            yearly: true,
          } as PrepaymentStrategy,
        },
      ],
      monthKey(new Date()),
    );
  });

  /** One balance curve per strategy, all sharing the baseline's timeline. */
  protected readonly curves = computed<Series[]>(() => {
    const rows = this.comparison();
    if (!rows.length) return [];
    const span = rows[0].forecast.months;
    return rows.map((row) => ({
      label: row.label,
      values: sampleYearly(balanceCurve(row.forecast, span)),
    }));
  });

  protected readonly curveLabels = computed(() => {
    const rows = this.comparison();
    if (!rows.length) return [];
    const years = Math.ceil(rows[0].forecast.months / 12);
    return Array.from({ length: years }, (_, i) => `Yr ${i + 1}`);
  });

  protected readonly formatAxis = computed(() => {
    const mode = this.prefs.numberFormat();
    return (value: number): string => {
      const abs = Math.abs(value);
      if (mode === 'indian') {
        if (abs >= 10_000_000) return `₹${trim(value / 10_000_000)}Cr`;
        if (abs >= 100_000) return `₹${trim(value / 100_000)}L`;
      } else if (abs >= 1_000_000) {
        return `₹${trim(value / 1_000_000)}M`;
      }
      if (abs >= 1_000) return `₹${trim(value / 1_000)}k`;
      return formatInr(value, mode);
    };
  });

  constructor() {
    // Seed the prepayment slider from what recent months actually left over,
    // once history has hydrated. After that the slider is the user's scratchpad.
    const seed = effect(() => {
      if (!this.history.ready() || !this.finance.ready()) return;
      const surplus = this.recentSurplus();
      if (surplus > 0) this.lumpSum.set(roundToStep(surplus, this.LUMP.step));
      seed.destroy();
    });
  }

  /** Re-sync the prepayment slider with the recent surplus. */
  protected useSurplus(): void {
    const surplus = this.recentSurplus();
    if (surplus > 0) this.lumpSum.set(roundToStep(surplus, this.LUMP.step));
  }

  protected gapsFor(loan: Loan): string {
    return loanGaps(loan)
      .map((gap) => GAP_PROMPTS[gap])
      .join(', ');
  }

  protected monthLabelOf(key: string): string {
    return monthLabel(key);
  }

  /** Years and months, e.g. `18y 4m` — a bare month count means nothing at a glance. */
  protected tenure(months: number): string {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    if (!years) return `${rest}m`;
    return rest ? `${years}y ${rest}m` : `${years}y`;
  }
}

/** Take one reading a year so a 20-year loan is 20 points, not 240. */
function sampleYearly(balances: readonly number[]): number[] {
  const years = Math.ceil(balances.length / 12);
  return Array.from(
    { length: years },
    (_, i) => balances[Math.min((i + 1) * 12 - 1, balances.length - 1)] ?? 0,
  );
}

function roundToStep(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
