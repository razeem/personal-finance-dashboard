import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { InrPipe } from '../../inr-pipe';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ListOps } from '../../../core/finance/finance-store';
import {
  LinePeriod,
  LineItem,
  makeLineItem,
  sumLineItemsMonthly,
} from '../../../core/finance/finance.model';

/**
 * Editable list of `{ type, value }` rows bound to a `ListOps<LineItem>` from the
 * shared FinanceStore. Every edit writes straight through to the shared model.
 */
@Component({
  selector: 'app-line-item-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    InrPipe,
    FormsModule,
    DragDropModule,
    MatIconModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <div
      class="list"
      [class.list--period]="allowPeriod()"
      cdkDropList
      (cdkDropListDropped)="drop($event)"
    >
      @for (item of ops().items(); track item.id) {
        <div class="row" cdkDrag [attr.data-testid]="testid() + '-row'">
          <button
            type="button"
            class="row__handle"
            cdkDragHandle
            aria-label="Drag to reorder"
            [attr.data-testid]="testid() + '-drag'"
          >
            <mat-icon>drag_indicator</mat-icon>
          </button>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="row__type">
            <mat-label>{{ typeLabel() }}</mat-label>
            <input
              matInput
              [ngModel]="item.type"
              (ngModelChange)="ops().update(item.id, { type: $event })"
              [attr.data-testid]="testid() + '-type'"
            />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="row__value">
            <mat-label>{{ valueLabel() }}</mat-label>
            <span matTextPrefix>₹&nbsp;</span>
            <input
              matInput
              type="number"
              min="0"
              inputmode="numeric"
              [ngModel]="item.value"
              (ngModelChange)="ops().update(item.id, { value: +$event || 0 })"
              [attr.data-testid]="testid() + '-value'"
            />
          </mat-form-field>
          @if (allowPeriod()) {
            <mat-button-toggle-group
              class="row__period"
              [value]="item.period ?? 'monthly'"
              (change)="ops().update(item.id, { period: $event.value })"
              [attr.data-testid]="testid() + '-period'"
              aria-label="Payment frequency"
            >
              <mat-button-toggle value="monthly">/mo</mat-button-toggle>
              <mat-button-toggle value="yearly">/yr</mat-button-toggle>
            </mat-button-toggle-group>
          }
          <button
            mat-icon-button
            type="button"
            aria-label="Remove row"
            (click)="ops().remove(item.id)"
            [attr.data-testid]="testid() + '-remove'"
          >
            <mat-icon>delete_outline</mat-icon>
          </button>
        </div>
      } @empty {
        <p class="empty">{{ emptyText() }}</p>
      }

      <div class="list__foot">
        <button
          mat-stroked-button
          type="button"
          (click)="ops().add(newItem())"
          [attr.data-testid]="testid() + '-add'"
        >
          <mat-icon>add</mat-icon>
          {{ addLabel() }}
        </button>
        <span class="total app-num" [attr.data-testid]="testid() + '-total'">
          {{ total() | inr }}
        </span>
      </div>
    </div>
  `,
  styles: `
    .list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .row {
      display: grid;
      grid-template-columns: auto minmax(0, 1.5fr) minmax(0, 1fr) auto;
      gap: 0.5rem;
      align-items: center;
      background: var(--bg-card, transparent);
      border-radius: var(--r-control);
    }
    .list--period .row {
      grid-template-columns: auto minmax(0, 1.4fr) minmax(0, 1fr) auto auto;
    }
    .row__period {
      height: 40px;
    }
    .row__period .mat-button-toggle {
      font-size: 0.72rem;
    }
    .row__handle {
      display: grid;
      place-items: center;
      width: 28px;
      height: 40px;
      border: 0;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      cursor: grab;
      touch-action: none;
    }
    .row__handle:active {
      cursor: grabbing;
    }
    .row__handle mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    /* While dragging, keep the row styled and animate the others smoothly. */
    .cdk-drag-preview {
      box-shadow: var(--app-elevation-hover);
      border-radius: var(--r-control);
      background: var(--bg-elev, #fff);
    }
    .cdk-drag-placeholder {
      opacity: 0.35;
    }
    .cdk-drag-animating {
      transition: transform 220ms cubic-bezier(0.2, 0, 0, 1);
    }
    .list.cdk-drop-list-dragging .row:not(.cdk-drag-placeholder) {
      transition: transform 220ms cubic-bezier(0.2, 0, 0, 1);
    }
    mat-form-field {
      width: 100%;
    }
    .empty {
      margin: 0.25rem 0;
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.88rem;
    }
    .list__foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.25rem;
    }
    .total {
      font-weight: 700;
      font-size: 1.05rem;
    }
    @media (max-width: 560px) {
      .row {
        grid-template-columns: auto minmax(0, 1fr) auto;
      }
      .row__value {
        grid-column: 2;
      }
    }
  `,
})
export class LineItemList {
  readonly ops = input.required<ListOps<LineItem>>();
  readonly typeLabel = input<string>('Type');
  readonly valueLabel = input<string>('Amount');
  readonly addLabel = input<string>('Add row');
  readonly emptyText = input<string>('Nothing added yet.');
  readonly testid = input<string>('line-item');
  /** Show a per-row monthly/yearly toggle (e.g. insurance premiums). */
  readonly allowPeriod = input<boolean>(false);
  /** Default period for newly-added rows when `allowPeriod` is on. */
  readonly defaultPeriod = input<LinePeriod>('monthly');

  // Total is always the monthly-equivalent (period-aware); monthly rows are unaffected.
  protected readonly total = computed(() => sumLineItemsMonthly(this.ops().items()));

  protected newItem(): LineItem {
    return makeLineItem('', 0, this.allowPeriod() ? this.defaultPeriod() : undefined);
  }

  protected drop(event: CdkDragDrop<unknown>): void {
    this.ops().reorder(event.previousIndex, event.currentIndex);
  }
}
