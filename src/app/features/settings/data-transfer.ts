import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EncryptionService } from '../../core/crypto/encryption.service';
import { ImportMode, TransferService } from '../../core/transfer/transfer.service';
import {
  summarize,
  TransferError,
  TransferPayload,
  TransferSummary,
} from '../../core/transfer/transfer.model';
import { QrScanner } from './qr-scanner';

/**
 * "Transfer data" settings tab: move the whole local model between devices.
 * Export produces a compact code (copy/paste, or a photo-less QR); import
 * previews the payload, then merges or replaces local data.
 */
@Component({
  selector: 'app-data-transfer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatButtonModule, MatButtonToggleModule, MatIconModule, QrScanner],
  template: `
    <div class="flex flex-col gap-8">
      <!-- ================= EXPORT ================= -->
      <section class="flex flex-col gap-3" data-testid="transfer-export">
        <header>
          <span class="app-eyebrow">Move data to another device</span>
          <p class="m-0 text-sm text-[var(--mat-sys-on-surface-variant)]">
            Everything is stored only on this device. Export a code, then paste or scan it on the
            other device to bring your data across.
          </p>
        </header>

        @if (encrypted()) {
          <!--
            The code has to be readable by a device that has never seen this
            passphrase, so it is deliberately plaintext. Say so where the button
            is, not in a help page nobody opens.
          -->
          <p
            class="m-0 rounded-[var(--r-control)] border border-[var(--mat-sys-error)] p-3 text-sm"
            data-testid="transfer-plaintext-warning"
          >
            <strong>This code is not encrypted.</strong> Your data is encrypted on this device, but
            a transfer code has to be readable by the device you're moving to. Treat the code as
            carefully as the data itself, and delete it once you've used it.
          </p>
        }

        <div class="flex flex-wrap gap-2">
          <button
            mat-flat-button
            type="button"
            (click)="generate()"
            data-testid="transfer-generate"
          >
            <mat-icon>tag</mat-icon>
            {{ exporting() ? 'Generating…' : 'Generate code' }}
          </button>
          <button
            mat-stroked-button
            type="button"
            (click)="showQr()"
            data-testid="transfer-show-qr"
          >
            <mat-icon>qr_code_2</mat-icon>
            Show QR
          </button>
        </div>

        @if (exportCode(); as code) {
          <textarea
            readonly
            rows="4"
            class="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 font-mono text-xs break-all"
            data-testid="transfer-export-code"
            >{{ code }}</textarea>
          <button
            mat-stroked-button
            type="button"
            class="self-start"
            (click)="copy(code)"
            data-testid="transfer-copy"
          >
            <mat-icon>content_copy</mat-icon>
            Copy code
          </button>
        }

        @if (qrBusy()) {
          <p class="text-sm text-[var(--mat-sys-on-surface-variant)]">Building QR…</p>
        }
        @if (qrError(); as err) {
          <p class="text-sm text-[var(--mat-sys-error)]" data-testid="transfer-qr-error">
            {{ err }}
          </p>
        }
        @if (qrUrl(); as url) {
          <div class="flex flex-col items-center gap-2">
            <img
              [src]="url"
              alt="QR code containing your data"
              class="rounded-lg"
              width="288"
              height="288"
            />
            <p class="text-center text-xs text-[var(--mat-sys-on-surface-variant)]">
              The QR code excludes your profile photo — use “Copy code” to transfer that too.
            </p>
          </div>
        }
      </section>

      <hr class="border-0 border-t border-[var(--border)]" />

      <!-- ================= IMPORT ================= -->
      <section class="flex flex-col gap-3" data-testid="transfer-import">
        <header>
          <span class="app-eyebrow">Bring data in</span>
          <p class="m-0 text-sm text-[var(--mat-sys-on-surface-variant)]">
            Paste a code from your other device, or scan its QR.
          </p>
        </header>

        @if (showScanner()) {
          <app-qr-scanner (scanned)="onScanned($event)" (cancelled)="showScanner.set(false)" />
        } @else {
          <textarea
            rows="4"
            placeholder="Paste a transfer code here…"
            class="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 font-mono text-xs break-all"
            data-testid="transfer-import-code"
            [value]="importText()"
            (input)="onImportInput($event)"
          ></textarea>
          <div class="flex flex-wrap gap-2">
            <button
              mat-flat-button
              type="button"
              (click)="preview()"
              data-testid="transfer-preview"
            >
              <mat-icon>fact_check</mat-icon>
              {{ previewing() ? 'Checking…' : 'Preview' }}
            </button>
            <button
              mat-stroked-button
              type="button"
              (click)="showScanner.set(true)"
              data-testid="transfer-scan"
            >
              <mat-icon>qr_code_scanner</mat-icon>
              Scan QR
            </button>
          </div>
        }

        @if (previewError(); as err) {
          <p class="text-sm text-[var(--mat-sys-error)]" data-testid="transfer-import-error">
            {{ err }}
          </p>
        }

        @if (summary(); as s) {
          <div
            class="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4"
            data-testid="transfer-preview-summary"
          >
            <p class="m-0 text-sm">
              Exported {{ s.exportedAt ? (s.exportedAt | date: 'medium') : 'at an unknown time' }}.
            </p>

            @if (s.schemaUnsupported) {
              <p class="m-0 text-sm text-[var(--mat-sys-error)]">
                This code is from a newer version of the app. Some data may not import correctly —
                update this device if you can.
              </p>
            }

            <ul class="m-0 flex list-none flex-col gap-1 p-0">
              @for (c of s.collections; track c.key) {
                <li class="flex items-center justify-between gap-3 text-sm">
                  <span class="flex items-center gap-2">
                    <mat-icon class="text-base!" [class]="iconClass(c.status)">{{
                      statusIcon(c.status)
                    }}</mat-icon>
                    <strong>{{ c.label }}</strong>
                    <span class="text-[var(--mat-sys-on-surface-variant)]">{{ c.detail }}</span>
                  </span>
                  <span class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{
                    statusLabel(c)
                  }}</span>
                </li>
              }
            </ul>

            @if (s.importable) {
              <div class="flex flex-col gap-2">
                <span class="text-sm font-semibold">How should this be applied?</span>
                <mat-button-toggle-group
                  [value]="importMode()"
                  (change)="importMode.set($event.value)"
                  data-testid="transfer-mode"
                >
                  <mat-button-toggle value="replace" data-testid="transfer-mode-replace">
                    Replace all
                  </mat-button-toggle>
                  <mat-button-toggle value="merge" data-testid="transfer-mode-merge">
                    Merge
                  </mat-button-toggle>
                </mat-button-toggle-group>
                <p class="m-0 text-xs text-[var(--mat-sys-on-surface-variant)]">
                  @if (importMode() === 'replace') {
                    Erases all data on this device, then installs the imported data.
                  } @else {
                    Overwrites each imported section; anything not in the code is kept.
                  }
                </p>
                <button
                  mat-flat-button
                  type="button"
                  class="self-start"
                  [disabled]="importing()"
                  (click)="doImport()"
                  data-testid="transfer-import-apply"
                >
                  <mat-icon>download_done</mat-icon>
                  {{ importing() ? 'Importing…' : 'Import & reload' }}
                </button>
              </div>
            } @else {
              <p class="m-0 text-sm text-[var(--mat-sys-error)]">
                Nothing in this code can be imported by this version of the app.
              </p>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class DataTransfer {
  private readonly transfer = inject(TransferService);
  private readonly snackBar = inject(MatSnackBar);

  /** Drives the "this code is not encrypted" warning — only shown when it bites. */
  protected readonly encrypted = inject(EncryptionService).enabled;

  protected readonly exporting = signal(false);
  protected readonly exportCode = signal('');
  protected readonly qrUrl = signal('');
  protected readonly qrError = signal('');
  protected readonly qrBusy = signal(false);

  protected readonly showScanner = signal(false);
  protected readonly importText = signal('');
  protected readonly previewing = signal(false);
  protected readonly previewError = signal('');
  protected readonly summary = signal<TransferSummary | null>(null);
  protected readonly importMode = signal<ImportMode>('replace');
  protected readonly importing = signal(false);

  private pendingPayload: TransferPayload | null = null;

  protected async generate(): Promise<void> {
    this.exporting.set(true);
    this.qrUrl.set('');
    this.qrError.set('');
    try {
      this.exportCode.set(await this.transfer.exportAll());
    } catch (err) {
      console.error(err);
      this.snackBar.open('Export failed — see console', 'Dismiss', { duration: 4000 });
    } finally {
      this.exporting.set(false);
    }
  }

  protected async copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      this.snackBar.open('Transfer code copied', 'Dismiss', { duration: 3000 });
    } catch {
      this.snackBar.open('Could not copy — select the text and copy manually', 'Dismiss', {
        duration: 4000,
      });
    }
  }

  protected async showQr(): Promise<void> {
    this.qrBusy.set(true);
    this.qrError.set('');
    this.qrUrl.set('');
    try {
      // QR omits Blobs (the photo) to stay within a single scannable code.
      const code = await this.transfer.exportAll({ includeBlobs: false });
      const QRCode = (await import('qrcode')).default;
      this.qrUrl.set(
        await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, width: 576 }),
      );
    } catch (err) {
      console.error(err);
      this.qrError.set(
        'Your data is too large for a single QR code. Use “Copy code” and paste it instead.',
      );
    } finally {
      this.qrBusy.set(false);
    }
  }

  protected onImportInput(event: Event): void {
    this.importText.set((event.target as HTMLTextAreaElement).value);
    this.summary.set(null);
    this.previewError.set('');
  }

  protected onScanned(text: string): void {
    this.showScanner.set(false);
    this.importText.set(text);
    void this.preview();
  }

  protected async preview(): Promise<void> {
    const text = this.importText().trim();
    if (!text) return;
    this.previewing.set(true);
    this.previewError.set('');
    this.summary.set(null);
    try {
      const payload = await this.transfer.decode(text);
      this.pendingPayload = payload;
      this.summary.set(summarize(payload));
    } catch (err) {
      this.pendingPayload = null;
      this.previewError.set(
        err instanceof TransferError ? err.message : 'Could not read this transfer code.',
      );
    } finally {
      this.previewing.set(false);
    }
  }

  protected async doImport(): Promise<void> {
    if (!this.pendingPayload) return;
    this.importing.set(true);
    try {
      await this.transfer.import(this.pendingPayload, this.importMode());
      // A successful import reloads the page, so we never fall through here.
    } catch (err) {
      console.error(err);
      this.importing.set(false);
      this.snackBar.open('Import failed — see console', 'Dismiss', { duration: 4000 });
    }
  }

  protected statusIcon(status: TransferSummary['collections'][number]['status']): string {
    switch (status) {
      case 'ok':
        return 'check_circle';
      case 'will-migrate':
        return 'upgrade';
      case 'newer-unsupported':
        return 'block';
      default:
        return 'help';
    }
  }

  protected iconClass(status: TransferSummary['collections'][number]['status']): string {
    return status === 'newer-unsupported'
      ? 'text-[var(--mat-sys-error)]'
      : status === 'ok'
        ? 'text-[var(--accent-2)]'
        : 'text-[var(--mat-sys-on-surface-variant)]';
  }

  protected statusLabel(c: TransferSummary['collections'][number]): string {
    switch (c.status) {
      case 'ok':
        return 'ready';
      case 'will-migrate':
        return `upgrades v${c.version} → v${c.currentVersion}`;
      case 'newer-unsupported':
        return `newer (v${c.version}) — skipped`;
      default:
        return 'unknown section';
    }
  }
}
