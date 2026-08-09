/**
 * Pure WebCrypto primitives for at-rest encryption.
 *
 * Framework-free and fully unit-tested, in the same spirit as `transfer.model.ts`
 * — the Angular services above only wire these to IndexedDB and the DOM.
 *
 * The shape of the scheme:
 *
 * - One **master key** (AES-GCM-256) encrypts every stored document. It is
 *   generated once, never derived from anything the user types, and never
 *   leaves memory in the clear.
 * - The master key is **wrapped** by key-encryption keys derived from what the
 *   user can actually present: a passphrase (PBKDF2) or a passkey's PRF output
 *   (HKDF). Wrapping it twice is what lets a passkey be lost without the data
 *   going with it — the passphrase always opens the same master key.
 * - Rotating an unlock method rewraps the master key. Nothing stored has to be
 *   re-encrypted, because the master key itself never changes.
 *
 * Every derivation parameter (salt, iteration count) is recorded **on the
 * wrapped-key record**, so the cost can be raised later without stranding
 * records written under the old settings.
 */

/** Iterations for passphrase derivation. OWASP's 2023 floor for PBKDF2-SHA-256. */
export const PBKDF2_ITERATIONS = 600_000;

/** AES-GCM nonce length. 96 bits is the size the algorithm is specified around. */
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** Payload schema version, carried on every encrypted document. */
export const CRYPTO_VERSION = 1;

export type UnlockKind = 'passphrase' | 'prf';

/** Thrown by everything here. `code` is machine-readable, like `TransferError`. */
export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'bad-key' | 'corrupt' | 'version' | 'weak-passphrase',
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * An encrypted document, as stored. Deliberately JSON-safe (base64, not
 * `ArrayBuffer`) so it survives structured clone, export and inspection without
 * special handling.
 *
 * The salt is NOT here: every payload is encrypted with the same master key, so
 * salt belongs to the key-derivation record, not to each document.
 */
export interface EncryptedPayload {
  /** Marker + schema version. Its presence is how storage tells cipher from plain. */
  v: number;
  /** base64 initialisation vector, 12 bytes, fresh per encryption. */
  iv: string;
  /** base64 ciphertext with its GCM authentication tag appended. */
  ct: string;
}

/**
 * The master key, wrapped by one unlock method. Several of these exist at once
 * — one per way in — and all of them unwrap to the same master key.
 */
export interface WrappedKey {
  v: number;
  kind: UnlockKind;
  /** base64 wrapped master key. */
  key: string;
  /** base64 IV used to wrap it. */
  iv: string;
  /** base64 salt fed to the derivation. */
  salt: string;
  /** PBKDF2 iterations, recorded so the cost can be raised without breaking this record. */
  iterations?: number;
  /** Free-form label for the UI ("iPhone Touch ID"). */
  label?: string;
  /**
   * base64url credential id, for `prf` records. The passkey is discoverable so
   * this is not strictly required to sign in, but naming it in `allowCredentials`
   * makes the prompt land on the right key instead of offering a chooser.
   */
  credentialId?: string;
}

// --- Availability ----------------------------------------------------------

/** True when this environment can do everything below. */
export function isCryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.encrypt === 'function';
}

function subtle(): SubtleCrypto {
  if (!isCryptoAvailable()) {
    throw new CryptoError('WebCrypto is not available in this browser.', 'unsupported');
  }
  return globalThis.crypto.subtle;
}

// --- Keys ------------------------------------------------------------------

/** A fresh random salt for a key derivation. */
export function randomSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * A brand-new master key. Extractable on purpose — it has to be exportable to
 * be wrapped — but it is only ever exported *into* a wrap, never into storage.
 */
export function generateMasterKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>;
}

/**
 * Stretch a passphrase into a key-encryption key.
 *
 * PBKDF2-SHA-256 at `iterations`. The count is a parameter rather than a
 * constant so tests can run cheaply and so a stored record can be reopened at
 * whatever cost it was written with.
 */
export async function deriveFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (!passphrase) {
    throw new CryptoError('A passphrase is required.', 'weak-passphrase');
  }
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Turn a passkey's PRF output into a key-encryption key.
 *
 * The PRF output is already uniformly random key material, so this is HKDF
 * (extract-and-expand) rather than a slow stretch — there is no low-entropy
 * secret here to protect against guessing.
 */
export async function deriveFromPrf(prfOutput: BufferSource, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('personal-finance-master-key') as BufferSource,
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Wrap the master key under a derived key-encryption key. */
export async function wrapMasterKey(
  master: CryptoKey,
  wrapping: CryptoKey,
  kind: UnlockKind,
  salt: Uint8Array,
  options: { iterations?: number; label?: string } = {},
): Promise<WrappedKey> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await subtle().wrapKey('raw', master, wrapping, {
    name: 'AES-GCM',
    iv: iv as BufferSource,
  });
  return {
    v: CRYPTO_VERSION,
    kind,
    key: toBase64(new Uint8Array(wrapped)),
    iv: toBase64(iv),
    salt: toBase64(salt),
    ...(options.iterations !== undefined ? { iterations: options.iterations } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

/**
 * Recover the master key from a wrapped record.
 *
 * A wrong passphrase fails here and nowhere else: AES-GCM authenticates, so an
 * incorrect key-encryption key cannot produce a plausible-looking master key —
 * it throws, and that becomes `bad-key`.
 */
export async function unwrapMasterKey(record: WrappedKey, wrapping: CryptoKey): Promise<CryptoKey> {
  requireVersion(record?.v);
  let bytes: Uint8Array;
  let iv: Uint8Array;
  try {
    bytes = fromBase64(record.key);
    iv = fromBase64(record.iv);
  } catch {
    throw new CryptoError('The stored key record is corrupt.', 'corrupt');
  }

  try {
    return await subtle().unwrapKey(
      'raw',
      bytes as BufferSource,
      wrapping,
      { name: 'AES-GCM', iv: iv as BufferSource },
      { name: 'AES-GCM', length: KEY_BITS },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new CryptoError('That passphrase or passkey does not open this data.', 'bad-key');
  }
}

/** The salt a wrapped record was written with. */
export function saltOf(record: WrappedKey): Uint8Array {
  try {
    return fromBase64(record.salt);
  } catch {
    throw new CryptoError('The stored key record is corrupt.', 'corrupt');
  }
}

// --- Payloads --------------------------------------------------------------

/** Encrypt any JSON-serialisable value under the master key. */
export async function encryptJson(value: unknown, key: CryptoKey): Promise<EncryptedPayload> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value ?? null));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { v: CRYPTO_VERSION, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Decrypt a payload written by `encryptJson`. */
export async function decryptJson<T>(payload: EncryptedPayload, key: CryptoKey): Promise<T> {
  if (!isEncryptedPayload(payload)) {
    throw new CryptoError('This is not an encrypted payload.', 'corrupt');
  }
  requireVersion(payload.v);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.iv) as BufferSource },
      key,
      fromBase64(payload.ct) as BufferSource,
    );
  } catch {
    throw new CryptoError('The stored data could not be decrypted.', 'bad-key');
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new CryptoError('The decrypted data is not valid JSON.', 'corrupt');
  }
}

/**
 * Whether a stored value is one of ours. Storage uses this to tell an encrypted
 * document from a plaintext one, so a half-migrated database still reads.
 */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncryptedPayload).v === 'number' &&
    typeof (value as EncryptedPayload).iv === 'string' &&
    typeof (value as EncryptedPayload).ct === 'string'
  );
}

function requireVersion(version: unknown): void {
  if (version !== CRYPTO_VERSION) {
    throw new CryptoError(
      `This data was written by a newer version of the app (v${String(version)}).`,
      'version',
    );
  }
}

// --- base64 <-> bytes (chunked to avoid arg-list limits) --------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
