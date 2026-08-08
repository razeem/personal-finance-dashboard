import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { InrPipe } from '../../shared/inr-pipe';
import { FinanceStore } from '../../core/finance/finance-store';
import {
  LinePeriod,
  Loan,
  LoanGap,
  LoanKind,
  loanGaps,
  makeLoan,
  monthlyEmi,
} from '../../core/finance/finance.model';

/** What each gap says to the user, in the prompt. */
const GAP_LABELS: Record<LoanGap, string> = {
  emi: 'the instalment',
  principal: 'the outstanding balance',
  rate: 'the interest rate',
  billedYearly: 'a monthly instalment',
};

/**
 * The Loan pillar's editor.
 *
 * A loan carries more than an amount now, but only `name` and `emi` are required
 * — those two are all the budget needs. The rest is what a debt-free forecast
 * needs, and each row says plainly what it is still missing rather than hiding
 * itself until it is complete.
 */
@Component({
  selector: 'app-loan-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    InrPipe,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './loan-list.html',
})
export class LoanList {
  private readonly store = inject(FinanceStore);

  protected readonly loans = this.store.loans;
  protected readonly total = computed(() => this.store.derived().totalLoanEmis);

  protected readonly kinds: { value: LoanKind; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'other', label: 'Other' },
  ];

  protected add(): void {
    this.loans.add(makeLoan());
  }

  protected set(id: string, patch: Partial<Loan>): void {
    this.loans.update(id, patch);
  }

  protected setAmount(
    id: string,
    field: 'emi' | 'principal' | 'annualRatePct',
    raw: unknown,
  ): void {
    const n = Number(raw);
    this.set(id, { [field]: Number.isFinite(n) && n >= 0 ? n : null } as Partial<Loan>);
  }

  protected setPeriod(id: string, period: LinePeriod): void {
    this.set(id, { period });
  }

  protected monthly(loan: Loan): number {
    return monthlyEmi(loan);
  }

  /** What this loan still needs before it can be forecast, as readable phrases. */
  protected gaps(loan: Loan): string[] {
    return loanGaps(loan).map((gap) => GAP_LABELS[gap]);
  }

  protected isBilledYearly(loan: Loan): boolean {
    return loan.period === 'yearly';
  }

  protected convert(loan: Loan): void {
    this.store.convertLoanToMonthly(loan.id);
  }
}
