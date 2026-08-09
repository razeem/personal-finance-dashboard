import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import {
  NumberFormat,
  PreferencesStore,
  ThemeMode,
} from '../../core/preferences/preferences-store';
import { ProfileForm } from './profile-form';
import { TaxRulesForm } from './tax-rules-form';
import { AssumptionsForm } from './assumptions-form';
import { DataTransfer } from './data-transfer';
import { EncryptionForm } from './encryption-form';

@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogModule,
    MatTabsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    ProfileForm,
    TaxRulesForm,
    AssumptionsForm,
    DataTransfer,
    EncryptionForm,
  ],
  template: `
    <div class="head">
      <h2 mat-dialog-title>Profile &amp; settings</h2>
      <button mat-icon-button mat-dialog-close aria-label="Close">
        <mat-icon>close</mat-icon>
      </button>
    </div>

    <mat-dialog-content>
      <mat-tab-group animationDuration="200ms">
        <mat-tab label="Profile">
          <div class="pane">
            <app-profile-form />
          </div>
        </mat-tab>
        <mat-tab label="Tax rules">
          <div class="pane">
            <app-tax-rules-form />
          </div>
        </mat-tab>
        <mat-tab label="Assumptions">
          <div class="pane">
            <app-assumptions-form />
          </div>
        </mat-tab>
        <mat-tab label="Preferences">
          <div class="pane">
            <section class="pref">
              <div class="pref__label">
                <span class="pref__title">Theme</span>
                <span class="pref__help">Follow your system, or force light/dark.</span>
              </div>
              <mat-button-toggle-group
                [value]="prefs.theme()"
                (change)="setTheme($event.value)"
                data-testid="theme-toggle"
              >
                <mat-button-toggle value="system"
                  ><mat-icon>brightness_auto</mat-icon></mat-button-toggle
                >
                <mat-button-toggle value="light"><mat-icon>light_mode</mat-icon></mat-button-toggle>
                <mat-button-toggle value="dark"><mat-icon>dark_mode</mat-icon></mat-button-toggle>
              </mat-button-toggle-group>
            </section>

            <section class="pref">
              <div class="pref__label">
                <span class="pref__title">Number format</span>
                <span class="pref__help">
                  Indian grouping (₹10,00,000) or international (₹1,000,000).
                </span>
              </div>
              <mat-button-toggle-group
                [value]="prefs.numberFormat()"
                (change)="setNumberFormat($event.value)"
                data-testid="number-format-toggle"
              >
                <mat-button-toggle value="indian">Indian</mat-button-toggle>
                <mat-button-toggle value="international">Intl</mat-button-toggle>
              </mat-button-toggle-group>
            </section>

            <section
              class="pref print:hidden mt-6 border-t border-[var(--border)] pt-5"
              data-testid="support-row"
            >
              <div class="pref__label">
                <span class="pref__title">Support</span>
                <span class="pref__help">If this saved you time, you can buy me a coffee.</span>
              </div>
              <a
                mat-stroked-button
                href="https://buymeacoffee.com/razeem"
                target="_blank"
                rel="noopener"
                data-testid="buy-me-a-coffee"
              >
                <mat-icon>local_cafe</mat-icon>
                Buy me a coffee
              </a>
            </section>
          </div>
        </mat-tab>
        <mat-tab label="Encryption">
          <div class="pt-4">
            <app-encryption-form />
          </div>
        </mat-tab>
        <mat-tab label="Transfer data">
          <div class="pane">
            <app-data-transfer />
          </div>
        </mat-tab>
      </mat-tab-group>
    </mat-dialog-content>
  `,
  styles: `
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.5rem 0 1.25rem;
    }
    .head h2 {
      margin: 0;
    }
    mat-dialog-content {
      width: min(560px, 92vw);
      padding-top: 0.5rem;
    }
    .pane {
      padding: 1.25rem 0.25rem 0.5rem;
    }
    .pref {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .pref + .pref {
      margin-top: 1.25rem;
    }
    .pref__title {
      display: block;
      font-weight: 600;
    }
    .pref__help {
      font-size: 0.82rem;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class SettingsDialog {
  protected readonly prefs = inject(PreferencesStore);
  private readonly dialogRef = inject(MatDialogRef<SettingsDialog>);

  protected setTheme(theme: ThemeMode): void {
    this.prefs.setTheme(theme);
  }

  protected setNumberFormat(format: NumberFormat): void {
    this.prefs.setNumberFormat(format);
  }
}
