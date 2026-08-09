import { inject, Injectable } from '@angular/core';
import { dumpAllCollections, writeCollections } from '../storage/db';
import { CRYPTO_META_KEY, EncryptionService } from '../crypto/encryption.service';
import {
  decode,
  encode,
  importableKeys,
  summarize,
  TRANSFER_APP,
  TRANSFER_SCHEMA,
  TransferPayload,
  TransferSummary,
} from './transfer.model';

export type ImportMode = 'replace' | 'merge';

/**
 * Cross-device data transfer: snapshot the whole IndexedDB model into one
 * portable string (copy/paste or QR) and rehydrate it on another device.
 *
 * Pure serialisation lives in `transfer.model.ts`; this only bridges it to
 * storage + the clock, and applies an imported payload.
 */
@Injectable({ providedIn: 'root' })
export class TransferService {
  private readonly encryption = inject(EncryptionService);

  /**
   * Snapshot every stored collection into a transfer code.
   * `includeBlobs: false` drops the profile photo (QR can't hold it).
   *
   * The code is **plaintext even when at-rest encryption is on**: it has to be
   * readable by another device that has never seen this passphrase, and the
   * whole point is portability. Collections are therefore decrypted on the way
   * out, and the crypto metadata (wrapped keys, salts) is left behind entirely
   * — it describes this device's unlock, not the data. The Transfer tab says so
   * plainly; treat a code as being as sensitive as the data itself.
   */
  async exportAll({ includeBlobs = true } = {}): Promise<string> {
    const stored = await dumpAllCollections();
    const collections = Object.fromEntries(
      await Promise.all(
        Object.entries(stored)
          .filter(([key]) => key !== CRYPTO_META_KEY)
          .map(async ([key, envelope]) => [
            key,
            { ...envelope, data: await this.encryption.openIfSealed(envelope.data) },
          ]),
      ),
    );
    const payload: TransferPayload = {
      app: TRANSFER_APP,
      schema: TRANSFER_SCHEMA,
      exportedAt: Date.now(),
      collections,
    };
    return encode(payload, { includeBlobs });
  }

  /** Decode + validate a pasted/scanned code into a payload. Throws `TransferError`. */
  decode(text: string): Promise<TransferPayload> {
    return decode(text);
  }

  /** Decode a code and describe what importing it would do. */
  async preview(text: string): Promise<TransferSummary> {
    return summarize(await this.decode(text));
  }

  /**
   * Apply a payload to local storage, then reload so every store re-hydrates
   * and runs its own migrator. `merge` writes only the collections present in
   * the payload (incoming wins), leaving others untouched; `replace` clears the
   * store first. Collections the payload marks `newer-unsupported` are skipped.
   */
  async import(payload: TransferPayload, mode: ImportMode): Promise<void> {
    const summary = summarize(payload);
    const allowed = new Set(importableKeys(summary));
    const envelopes = Object.fromEntries(
      Object.entries(payload.collections).filter(([key]) => allowed.has(key)),
    );
    // Incoming documents are plaintext; re-seal them so an encrypted device
    // stays encrypted after an import. A `replace` would otherwise wipe the
    // crypto metadata too, so it is preserved explicitly.
    const sealed = Object.fromEntries(
      await Promise.all(
        Object.entries(envelopes).map(async ([key, envelope]) => [
          key,
          { ...envelope, data: await this.encryption.sealIfEnabled(envelope.data) },
        ]),
      ),
    );
    await writeCollections(sealed, { replace: mode === 'replace', keep: [CRYPTO_META_KEY] });
    globalThis.location?.reload();
  }
}
