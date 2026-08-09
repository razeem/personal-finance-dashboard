import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CryptoError } from '../../core/crypto/crypto.model';
import { BiometricService } from '../../core/crypto/biometric.service';
import {
  EncryptionService,
  IDLE_LOCK_MS,
  MIN_PASSPHRASE_LENGTH,
} from '../../core/crypto/encryption.service';

/**
 * Settings → Encryption. Turning it on, changing the passphrase, and adding or
 * removing a passkey.
 *
 * The passphrase is mandatory and the passkey is optional on purpose: a passkey
 * can be lost with the device, and the passphrase is the only thing that
 * guarantees the data can still be opened. The copy says so, because there is
 * no recovery path by design.
 */
@Component({
  selector: 'app-encryption-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  templateUrl: './encryption-form.html',
})
export class EncryptionForm {
  private readonly encryption = inject(EncryptionService);
  private readonly biometric = inject(BiometricService);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly MIN_PASSPHRASE_LENGTH = MIN_PASSPHRASE_LENGTH;
  protected readonly idleMinutes = Math.round(IDLE_LOCK_MS / 60_000);

  protected readonly enabled = this.encryption.enabled;
  protected readonly available = this.encryption.available;
  protected readonly hasBiometric = this.encryption.hasBiometric;

  protected readonly busy = signal(false);
  protected readonly error = signal('');

  // Enable
  protected readonly newPassphrase = signal('');
  protected readonly confirmPassphrase = signal('');
  // Change
  protected readonly currentPassphrase = signal('');
  protected readonly nextPassphrase = signal('');
  // Disable
  protected readonly disablePassphrase = signal('');

  protected readonly biometricSupported = signal(false);

  protected readonly canEnable = computed(
    () =>
      this.newPassphrase().length >= MIN_PASSPHRASE_LENGTH &&
      this.newPassphrase() === this.confirmPassphrase(),
  );
  protected readonly mismatch = computed(
    () => !!this.confirmPassphrase() && this.newPassphrase() !== this.confirmPassphrase(),
  );

  constructor() {
    void this.biometric.isSupported().then((ok) => this.biometricSupported.set(ok));
  }

  protected async enable(): Promise<void> {
    await this.run(async () => {
      await this.encryption.enable(this.newPassphrase());
      this.newPassphrase.set('');
      this.confirmPassphrase.set('');
      this.snackBar.open('Encryption is on. Everything stored is now encrypted.', 'Dismiss', {
        duration: 4000,
      });
    });
  }

  protected async disable(): Promise<void> {
    await this.run(async () => {
      await this.encryption.disable(this.disablePassphrase());
      this.disablePassphrase.set('');
      this.snackBar.open('Encryption is off.', 'Dismiss', { duration: 3000 });
    });
  }

  protected async changePassphrase(): Promise<void> {
    await this.run(async () => {
      await this.encryption.changePassphrase(this.currentPassphrase(), this.nextPassphrase());
      this.currentPassphrase.set('');
      this.nextPassphrase.set('');
      this.snackBar.open('Passphrase changed.', 'Dismiss', { duration: 3000 });
    });
  }

  protected async addBiometric(): Promise<void> {
    await this.run(async () => {
      const added = await this.encryption.addBiometric();
      this.snackBar.open(
        added
          ? 'Passkey added. You can unlock with it from now on.'
          : "This device's passkey can't hold an encryption key — keep using the passphrase.",
        'Dismiss',
        { duration: 5000 },
      );
    });
  }

  protected async removeBiometric(): Promise<void> {
    await this.run(async () => {
      await this.encryption.removeBiometric();
      this.snackBar.open('Passkey removed.', 'Dismiss', { duration: 3000 });
    });
  }

  protected lockNow(): void {
    this.encryption.lock();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (err) {
      this.error.set(err instanceof CryptoError ? err.message : 'Something went wrong.');
    } finally {
      this.busy.set(false);
    }
  }
}
