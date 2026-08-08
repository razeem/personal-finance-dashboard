import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatTabsModule } from '@angular/material/tabs';
import { InrPipe } from '../../shared/inr-pipe';
import { FinanceStore } from '../../core/finance/finance-store';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { SectionCard } from '../../shared/ui/section-card/section-card';
import { StatTile } from '../../shared/ui/stat-tile/stat-tile';
import { LineItemList } from '../../shared/ui/line-item-list/line-item-list';
import { SpendingHistory } from './spending-history';

@Component({
  selector: 'app-spending',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    InrPipe,
    MatTabsModule,
    PageHeader,
    SectionCard,
    StatTile,
    LineItemList,
    SpendingHistory,
  ],
  templateUrl: './spending.html',
})
export class Spending {
  private readonly store = inject(FinanceStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly needs = this.store.needs;
  protected readonly wants = this.store.wants;
  protected readonly derived = this.store.derived;

  // ---- Deep-linkable tabs (?tab=budget|history) ----
  private readonly tabSlugs = ['budget', 'history'];
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  protected readonly selectedTab = computed(() => {
    const idx = this.tabSlugs.indexOf(this.queryParams().get('tab') ?? '');
    return idx >= 0 ? idx : 0;
  });
  protected onTabChange(index: number): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: this.tabSlugs[index] },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
