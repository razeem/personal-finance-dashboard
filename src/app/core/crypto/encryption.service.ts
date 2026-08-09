import { computed, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { getDb, StoredEnvelope, transformAllCollections } from '../storage/db';
import { BiometricService } from './biometric.service';
import {
  CryptoError,
  decryptJson,
  deriveFromPassphrase,
  deriveFromPrf,
  encryptJson,
  EncryptedPayload,
  generateMasterKey,
  isCryptoAvailable,
  PBKDF2_ITERATIONS,
  randomSalt,
  saltOf,
  unwrapMasterKey,
  UnlockKind,
  WrappedKey,
  wrapMasterKey,
} from './crypto.model';

/**
 * Whether encryption is on, and whether this session has been let in.
 *
 * This is the only thing that holds the master key, and it holds it **in a
 * module-scope variable, never in a signal or any store** — signals get read by
 * templates and serialised by devtools; a raw `CryptoKey` in a closure does not.
 * A page reload therefore always relocks, because the variable dies with the
 * page. Within a session an idle timer relocks too.
 *
 * Reads and writes `crypto-meta` through `getDb()` directly rather than through
 * `StorageService`, because StorageService depends on *this* to encrypt — going
 * the other way would be a cycle.
 */

/** Reserved collection key. Always plaintext: it is what tells us how to unlock. */
export const CRYPTO_META_KEY = 'crypto-meta';

/** Relock after this long without interaction. */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

export interface CryptoMeta {
  enabled: boolean;
  /** One wrapped copy of the master key per way in. The passphrase is always present. */
  keys: WrappedKey[];
}

const DEFAULT_META: CryptoMeta = { enabled: false, keys: [] };

/**
 * The master key, out of reach of anything reflective. Module scope rather than
 * a field so it is not reachable from an injected service reference either.
 */
let masterKey: CryptoKey | null = null;

@Injectable({ providedIn: 'root' })
export class EncryptionService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly biometric = inject(BiometricService);

  private readonly meta = signal<CryptoMeta>(DEFAULT_META);
  private readonly lockedState = signal(true);
  private readonly readyState = signal(false);

  /** True once `crypto-meta` has been read and we know whether to gate anything. */
  readonly ready = this.readyState.asReadonly();
  readonly enabled = computed(() => this.meta().enabled);
  /** Locked only means anything while enabled. */
  readonly locked = computed(() => this.enabled() && this.lockedState());
  readonly methods = computed(() => this.meta().keys);
  readonly hasBiometric = computed(() => this.meta().keys.some((k) => k.kind === 'prf'));
  readonly available = computed(() => isCryptoAvailable());

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;
  private unlockGate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private loaded: Promise<void> | null = null;

  /**
   * Read `crypto-meta`. Called by StorageService before it hydrates anything, so
   * a locked database is never read in the wrong order. Idempotent.
   */
  load(): Promise<void> {
    this.loaded ??= this.readMeta();
    return this.loaded;
  }

  private async readMeta(): Promise<void> {
    if (!this.isBrowser) {
      // Prerender: nothing is stored, nothing is locked, nothing to gate.
      this.readyState.set(true);
      this.lockedState.set(false);
      return;
    }
    try {
      const db = await getDb();
      const stored = (await db.get('collections', CRYPTO_META_KEY)) as
        StoredEnvelope<CryptoMeta> | undefined;
      const meta = stored?.data ?? DEFAULT_META;
      this.meta.set(meta);
      this.lockedState.set(meta.enabled);
      if (meta.enabled) this.closeGate();
    } catch (err) {
      console.error('[EncryptionService] Could not read crypto-meta', err);
    } finally {
      this.readyState.set(true);
    }
  }

  /**
   * Resolves once the app is readable: immediately when encryption is off,
   * otherwise when the session is unlocked. StorageService awaits this before
   * touching a document, which is what keeps the lock screen in front of data.
   */
  async whenReadable(): Promise<void> {
    await this.load();
    if (!this.enabled() || !this.lockedState()) return;
    await this.unlockGate;
  }

  /** The in-memory master key, or null when off or locked. */
  key(): CryptoKey | null {
    return this.enabled() ? masterKey : null;
  }

  // ---- Unlocking ----------------------------------------------------------

  async unlockWithPassphrase(passphrase: string): Promise<void> {
    const record = this.recordFor('passphrase');
    if (!record) throw new CryptoError('No passphrase is set up.', 'bad-key');
    const wrapping = await deriveFromPassphrase(
      passphrase,
      saltOf(record),
      record.iterations ?? PBKDF2_ITERATIONS,
    );
    masterKey = await unwrapMasterKey(record, wrapping);
    this.openGate();
  }

  async unlockWithBiometric(): Promise<void> {
    const record = this.recordFor('prf');
    if (!record) throw new CryptoError('No passkey is set up.', 'bad-key');
    const prf = await this.biometric.authenticate(record.credentialId);
    masterKey = await unwrapMasterKey(record, await deriveFromPrf(prf, saltOf(record)));
    this.openGate();
  }

  /** Drop the key and put the lock screen back. */
  lock(): void {
    masterKey = null;
    if (!this.enabled()) return;
    this.lockedState.set(true);
    this.closeGate();
    this.clearIdleTimer();
    this.unwatchActivity();
  }

  /**
   * Restart the idle countdown. Wired to document-level listeners rather than to
   * anything in a template — every interaction anywhere counts, and the shell
   * shouldn't have to know this feature exists.
   */
  noteActivity = (): void => {
    if (!this.isBrowser || !this.enabled() || this.lockedState()) return;
    this.startIdleTimer();
  };

  private watchActivity(): void {
    if (!this.isBrowser || this.watching) return;
    this.watching = true;
    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, this.noteActivity, { passive: true });
    }
  }

  private unwatchActivity(): void {
    if (!this.isBrowser || !this.watching) return;
    this.watching = false;
    for (const event of ACTIVITY_EVENTS) {
      document.removeEventListener(event, this.noteActivity);
    }
  }

  // ---- Setup --------------------------------------------------------------

  /**
   * Turn encryption on. Generates the master key, wraps it under the passphrase
   * and stores the record. The caller is responsible for re-writing existing
   * documents encrypted (`StorageService.rewriteAll`).
   */
  async enable(passphrase: string): Promise<void> {
    requirePassphrase(passphrase);
    if (this.enabled()) throw new CryptoError('Encryption is already on.', 'bad-key');

    const key = await generateMasterKey();
    const salt = randomSalt();
    const wrapping = await deriveFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
    const record = await wrapMasterKey(key, wrapping, 'passphrase', salt, {
      iterations: PBKDF2_ITERATIONS,
      label: 'Passphrase',
    });

    // Encrypt what is already stored BEFORE recording that encryption is on, so
    // an interruption leaves plaintext-and-disabled rather than a database the
    // app thinks is encrypted but isn't.
    if (this.isBrowser) {
      await transformAllCollections((data) => encryptJson(data, key), { skip: [CRYPTO_META_KEY] });
    }

    masterKey = key;
    await this.writeMeta({ enabled: true, keys: [record] });
    this.lockedState.set(false);
    this.openGate();
  }

  /**
   * Turn encryption off. Requires the passphrase even while unlocked — this
   * removes the protection from every document, so it should cost something.
   */
  async disable(passphrase: string): Promise<void> {
    const key = await this.assertPassphrase(passphrase);

    // Decrypt everything first, then record that encryption is off. Interrupted
    // the other way round, the app would read ciphertext as if it were state.
    if (this.isBrowser) {
      await transformAllCollections(
        async (data) => (isSealed(data) ? await decryptJson(data as EncryptedPayload, key) : data),
        { skip: [CRYPTO_META_KEY] },
      );
    }

    await this.writeMeta({ enabled: false, keys: [] });
    masterKey = null;
    this.lockedState.set(false);
    this.openGate();
  }

  /** Rewrap the same master key under a new passphrase. Nothing is re-encrypted. */
  async changePassphrase(current: string, next: string): Promise<void> {
    requirePassphrase(next);
    const key = await this.assertPassphrase(current);
    const salt = randomSalt();
    const wrapping = await deriveFromPassphrase(next, salt, PBKDF2_ITERATIONS);
    const record = await wrapMasterKey(key, wrapping, 'passphrase', salt, {
      iterations: PBKDF2_ITERATIONS,
      label: 'Passphrase',
    });
    await this.writeMeta({
      enabled: true,
      keys: [record, ...this.meta().keys.filter((k) => k.kind !== 'passphrase')],
    });
  }

  /**
   * Add a passkey as a second way in. Requires an unlocked session, because it
   * wraps the master key that is currently in memory.
   *
   * Returns false when the device's authenticator has no PRF support — the
   * feature-detect the plan calls for, surfaced as a plain answer rather than an
   * error, because falling back to the passphrase is a normal outcome.
   */
  async addBiometric(label = 'This device'): Promise<boolean> {
    if (!masterKey) throw new CryptoError('Unlock first to add a passkey.', 'bad-key');
    const registration = await this.biometric.register(label);
    if (!registration) return false;

    const salt = randomSalt();
    const wrapping = await deriveFromPrf(registration.prfOutput, salt);
    const record = await wrapMasterKey(masterKey, wrapping, 'prf', salt, { label });

    await this.writeMeta({
      enabled: true,
      keys: [
        ...this.meta().keys.filter((k) => k.kind !== 'prf'),
        { ...record, credentialId: registration.credentialId },
      ],
    });
    return true;
  }

  /** Forget the passkey. The passphrase still opens everything. */
  async removeBiometric(): Promise<void> {
    await this.writeMeta({
      enabled: this.enabled(),
      keys: this.meta().keys.filter((k) => k.kind !== 'prf'),
    });
  }

  // ---- Payload helpers used by StorageService -----------------------------

  /** Encrypt when on and unlocked; otherwise hand the value straight back. */
  async sealIfEnabled(value: unknown): Promise<unknown> {
    const key = this.key();
    return key ? await encryptJson(value, key) : value;
  }

  /** Decrypt when the stored value is one of ours; otherwise pass it through. */
  async openIfSealed<T>(value: unknown): Promise<T> {
    const key = this.key();
    if (!key || !isSealed(value)) return value as T;
    return decryptJson<T>(value as EncryptedPayload, key);
  }

  // ---- internals ----------------------------------------------------------

  private recordFor(kind: UnlockKind): WrappedKey | undefined {
    return this.meta().keys.find((k) => k.kind === kind);
  }

  /** Confirm the passphrase and hand back the master key it opens. */
  private async assertPassphrase(passphrase: string): Promise<CryptoKey> {
    const record = this.recordFor('passphrase');
    if (!record) throw new CryptoError('No passphrase is set up.', 'bad-key');
    const wrapping = await deriveFromPassphrase(
      passphrase,
      saltOf(record),
      record.iterations ?? PBKDF2_ITERATIONS,
    );
    const key = await unwrapMasterKey(record, wrapping);
    masterKey = key;
    return key;
  }

  private async writeMeta(meta: CryptoMeta): Promise<void> {
    this.meta.set(meta);
    if (!this.isBrowser) return;
    const db = await getDb();
    await db.put(
      'collections',
      { version: 1, data: meta, updatedAt: Date.now() } as StoredEnvelope,
      CRYPTO_META_KEY,
    );
  }

  private openGate(): void {
    this.lockedState.set(false);
    this.releaseGate?.();
    this.releaseGate = null;
    this.unlockGate = null;
    this.startIdleTimer();
    this.watchActivity();
  }

  private closeGate(): void {
    if (this.unlockGate) return;
    this.unlockGate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  private startIdleTimer(): void {
    if (!this.isBrowser) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.lock(), IDLE_LOCK_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Anything that counts as "the user is still here". */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'visibilitychange'] as const;

/** Whether a stored value is an encrypted payload. Kept local to avoid a cycle. */
function isSealed(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncryptedPayload).iv === 'string' &&
    typeof (value as EncryptedPayload).ct === 'string'
  );
}

/** The one rule on passphrase strength, enforced in a single place. */
export const MIN_PASSPHRASE_LENGTH = 8;

function requirePassphrase(passphrase: string): void {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new CryptoError(
      `Use at least ${MIN_PASSPHRASE_LENGTH} characters — this is the only way back to your data.`,
      'weak-passphrase',
    );
  }
}
