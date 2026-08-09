import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { PILLARS } from './app.routes';
import { PreferencesStore } from './core/preferences/preferences-store';
import { ProfileStore } from './core/profile/profile-store';
import { FinanceWorkbookService } from './core/export/finance-workbook.service';
import { SeoService } from './core/seo/seo.service';
import { EncryptionService } from './core/crypto/encryption.service';
import { LockScreen } from './features/settings/lock-screen';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
    MatTooltipModule,
    LockScreen,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly prefs = inject(PreferencesStore);
  private readonly dialog = inject(MatDialog);
  private readonly workbook = inject(FinanceWorkbookService);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly profile = inject(ProfileStore);
  protected readonly pillars = PILLARS;
  protected readonly collapsed = this.prefs.sidebarCollapsed;
  protected readonly theme = this.prefs.theme;
  protected readonly exporting = signal(false);

  /**
   * The lock gate. `ready` guards the first paint so the app never flashes into
   * view before we know whether it should be locked.
   */
  private readonly encryption = inject(EncryptionService);
  protected readonly locked = this.encryption.locked;
  protected readonly encryptionReady = this.encryption.ready;

  /** Export the whole connected model (all pillars) as one .xlsx workbook — global action. */
  protected async exportWorkbook(): Promise<void> {
    this.exporting.set(true);
    try {
      await this.workbook.export('personal-finance');
      this.snackBar.open('Exported personal-finance.xlsx', 'Dismiss', { duration: 3000 });
    } catch (err) {
      console.error(err);
      this.snackBar.open('Export failed — see console', 'Dismiss', { duration: 4000 });
    } finally {
      this.exporting.set(false);
    }
  }

  /** On handset/tablet the sidenav is an overlay controlled by `mobileOpen`. */
  protected readonly isHandset = toSignal(
    this.breakpoints
      .observe([Breakpoints.Handset, Breakpoints.TabletPortrait])
      .pipe(map((result) => result.matches)),
    { initialValue: false },
  );
  protected readonly mobileOpen = signal(false);

  constructor() {
    inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-rounded');
    // Resolve per-route <title>/description/canonical/OG/robots/JSON-LD; runs during
    // prerender so the tags bake into each route's static HTML.
    inject(SeoService).init();
  }

  protected toggleSidebar(): void {
    if (this.isHandset()) {
      this.mobileOpen.update((open) => !open);
    } else {
      this.prefs.toggleSidebar();
    }
  }

  protected closeOnHandset(): void {
    if (this.isHandset()) {
      this.mobileOpen.set(false);
    }
  }

  protected cycleTheme(): void {
    const order = ['system', 'light', 'dark'] as const;
    const next = order[(order.indexOf(this.theme()) + 1) % order.length];
    this.prefs.setTheme(next);
  }

  protected async openSettings(): Promise<void> {
    // Lazy-load the settings dialog (and its exceljs/forms deps) on demand.
    const { SettingsDialog } = await import('./features/settings/settings-dialog');
    this.dialog.open(SettingsDialog, { autoFocus: false, restoreFocus: false });
  }
}
