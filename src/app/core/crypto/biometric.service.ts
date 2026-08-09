import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CryptoError } from './crypto.model';

/**
 * Unlocking with a passkey, via the WebAuthn **PRF extension**.
 *
 * PRF asks the authenticator to compute a keyed pseudo-random function over a
 * fixed input. The same passkey and the same input always give back the same 32
 * bytes, and those bytes never leave the device unless the user presents the
 * biometric — which is exactly the shape of a key-encryption key.
 *
 * Nothing here is a security boundary on its own: the PRF output is fed to
 * `deriveFromPrf` and only ever *unwraps* the master key. Losing the passkey
 * loses this route in, never the data — the passphrase wrap is always there.
 *
 * Every call is `isPlatformBrowser`-guarded; the build-time prerender must not
 * touch WebAuthn.
 */

/** The PRF input. Constant on purpose — same passkey + same salt = same key. */
const PRF_INPUT = new TextEncoder().encode('personal-finance-dashboard/master-key/v1');

/** Relying-party name shown in the platform's own prompt. */
const RP_NAME = 'Personal Finance';

export interface BiometricRegistration {
  credentialId: string;
  prfOutput: ArrayBuffer;
}

@Injectable({ providedIn: 'root' })
export class BiometricService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Whether this device has a platform authenticator (Touch ID, Windows Hello…). */
  async isSupported(): Promise<boolean> {
    if (!this.isBrowser || typeof PublicKeyCredential === 'undefined') return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Create a discoverable platform passkey and read its PRF output.
   *
   * PRF is requested at creation but only *evaluated* on an assertion, so this
   * registers and then immediately authenticates — one extra prompt at setup, in
   * exchange for knowing at setup time whether PRF actually works on this device
   * rather than discovering it at the first unlock.
   *
   * Returns `null` when the authenticator has no PRF support, which is the
   * signal to fall back to the passphrase.
   */
  async register(label: string): Promise<BiometricRegistration | null> {
    this.requireBrowser();

    const userId = crypto.getRandomValues(new Uint8Array(16));
    let created: PublicKeyCredential;
    try {
      created = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: RP_NAME, id: location.hostname },
          user: {
            id: userId,
            name: label || 'Personal Finance',
            displayName: label || 'This device',
          },
          // ES256 then RS256 — between them every platform authenticator in use.
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'required',
            userVerification: 'required',
          },
          timeout: 60_000,
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;
    } catch (err) {
      throw asCryptoError(err, 'The passkey was not created.');
    }

    const extensions = created.getClientExtensionResults() as PrfClientResults;
    if (extensions.prf?.enabled === false) {
      // The authenticator took the credential but cannot do PRF — useless to us.
      return null;
    }

    const credentialId = toBase64Url(new Uint8Array(created.rawId));
    const prfOutput = await this.evaluatePrf(credentialId);
    return prfOutput ? { credentialId, prfOutput } : null;
  }

  /**
   * Ask the authenticator for the PRF output, prompting for the biometric.
   * Throws `bad-key` if the user cancels or no matching passkey is present.
   */
  async authenticate(credentialId?: string): Promise<ArrayBuffer> {
    this.requireBrowser();
    const output = await this.evaluatePrf(credentialId);
    if (!output) {
      throw new CryptoError('This passkey cannot unlock your data.', 'unsupported');
    }
    return output;
  }

  private async evaluatePrf(credentialId?: string): Promise<ArrayBuffer | null> {
    let assertion: PublicKeyCredential;
    try {
      assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: location.hostname,
          userVerification: 'required',
          timeout: 60_000,
          ...(credentialId
            ? {
                allowCredentials: [
                  {
                    type: 'public-key' as const,
                    id: fromBase64Url(credentialId) as BufferSource,
                  },
                ] as PublicKeyCredentialDescriptor[],
              }
            : {}),
          extensions: {
            prf: { eval: { first: PRF_INPUT } },
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;
    } catch (err) {
      throw asCryptoError(err, 'Unlocking with your passkey was cancelled.');
    }

    const results = (assertion.getClientExtensionResults() as PrfClientResults).prf?.results?.first;
    return results ?? null;
  }

  private requireBrowser(): void {
    if (!this.isBrowser || typeof navigator === 'undefined' || !navigator.credentials) {
      throw new CryptoError('Passkeys are not available here.', 'unsupported');
    }
  }
}

/** The slice of the extension results we care about, which lib.dom does not type. */
interface PrfClientResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function asCryptoError(err: unknown, fallback: string): CryptoError {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new CryptoError(fallback, 'bad-key');
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return new CryptoError('Passkeys are not available here.', 'unsupported');
  }
  return new CryptoError(fallback, 'bad-key');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
