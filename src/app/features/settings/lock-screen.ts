import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CryptoError } from '../../core/crypto/crypto.model';
import { EncryptionService } from '../../core/crypto/encryption.service';

/**
 * What you see instead of the app when encryption is on and this session has
 * not been let in. Nothing behind it has loaded — the stores are still at their
 * defaults, because `StorageService` waits on the same gate this releases.
 *
 * Deliberately built from native inputs and Tailwind rather than Material form
 * fields, and reading the input directly rather than through `ngModel`: this
 * component sits in the **initial bundle** (it has to render before anything
 * else can), and Material's form field plus `FormsModule` cost ~150 kB on first
 * load for one screen most sessions never see.
 */
@Component({
  selector: 'app-lock-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <div
      class="fixed inset-0 z-[1000] grid place-items-center bg-[var(--bg)] p-5"
      data-testid="lock-screen"
    >
      <div class="flex w-full max-w-[22rem] flex-col gap-5">
        <div class="flex flex-col items-center gap-2 text-center">
          <span
            class="grid h-14 w-14 place-items-center rounded-full bg-[var(--mat-sys-primary-container)] text-[var(--mat-sys-on-primary-container)]"
          >
            <mat-icon class="!h-7 !w-7 !text-[28px]">lock</mat-icon>
          </span>
          <h1 class="m-0 text-[1.35rem] font-bold">Locked</h1>
          <p class="m-0 text-[0.88rem] text-[var(--mat-sys-on-surface-variant)]">
            Your data is encrypted on this device. Unlock to carry on.
          </p>
        </div>

        @if (hasBiometric()) {
          <button
            type="button"
            class="flex w-full items-center justify-center gap-2 rounded-[var(--r-control)] bg-[var(--mat-sys-primary)] px-4 py-3 font-semibold text-[var(--mat-sys-on-primary)] transition-[var(--transition)] disabled:opacity-50"
            [disabled]="busy()"
            (click)="unlockWithBiometric()"
            data-testid="lock-biometric"
          >
            <mat-icon class="!h-5 !w-5 !text-xl">fingerprint</mat-icon>
            Unlock with passkey
          </button>
          <div class="flex items-center gap-3 text-[0.75rem] text-[var(--mat-sys-outline)]">
            <span class="h-px flex-1 bg-[var(--border)]"></span>
            or
            <span class="h-px flex-1 bg-[var(--border)]"></span>
          </div>
        }

        <form class="flex flex-col gap-3" (submit)="submit($event, field.value)">
          <label class="flex flex-col gap-1.5">
            <span class="text-[0.8rem] font-medium">Passphrase</span>
            <input
              #field
              type="password"
              autocomplete="current-password"
              name="passphrase"
              class="w-full rounded-[var(--r-control)] border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5 text-[0.95rem] text-[var(--text)] outline-none focus:border-[var(--mat-sys-primary)] disabled:opacity-50"
              [disabled]="busy()"
              (input)="passphrase.set(field.value)"
              data-testid="lock-passphrase"
            />
          </label>

          @if (error()) {
            <p class="m-0 text-[0.82rem] text-[var(--mat-sys-error)]" data-testid="lock-error">
              {{ error() }}
            </p>
          }

          <button
            type="submit"
            class="w-full rounded-[var(--r-control)] bg-[var(--mat-sys-primary)] px-4 py-3 font-semibold text-[var(--mat-sys-on-primary)] transition-[var(--transition)] disabled:opacity-50"
            [disabled]="busy() || !passphrase()"
            data-testid="lock-submit"
          >
            {{ busy() ? 'Unlocking…' : 'Unlock' }}
          </button>
        </form>
      </div>
    </div>
  `,
})
export class LockScreen {
  private readonly encryption = inject(EncryptionService);

  protected readonly hasBiometric = this.encryption.hasBiometric;
  protected readonly passphrase = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected async submit(event: Event, value: string): Promise<void> {
    event.preventDefault();
    await this.attempt(() => this.encryption.unlockWithPassphrase(value));
  }

  protected async unlockWithBiometric(): Promise<void> {
    await this.attempt(() => this.encryption.unlockWithBiometric());
  }

  private async attempt(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (err) {
      this.error.set(
        err instanceof CryptoError ? err.message : 'Could not unlock. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
