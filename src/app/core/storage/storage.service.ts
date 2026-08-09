import { inject, Injectable, PLATFORM_ID, Signal, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { getDb, StoredEnvelope } from './db';
import { CRYPTO_META_KEY, EncryptionService } from '../crypto/encryption.service';

/** Upgrade a stored document from an older schema version to the current shape. */
export type Migrator<T> = (data: unknown, fromVersion: number) => T;

export interface CollectionConfig<T> {
  /** Unique key within the DB, e.g. 'profile' or 'income-tax'. */
  key: string;
  /** Current document schema version. Bump whenever the shape of `T` changes. */
  version: number;
  /** Value used before hydration completes and when nothing is stored yet. */
  defaults: T;
  /** Convert a stored document from an older `version` into the current shape. */
  migrate?: Migrator<T>;
  /** Trailing debounce for write-through persistence, in ms (default 250). */
  debounceMs?: number;
}

export interface PersistentCollection<T> {
  /** Current value — starts at `defaults`, then hydrates from IndexedDB. */
  readonly value: Signal<T>;
  /** Flips to `true` once the initial load from IndexedDB has settled. */
  readonly ready: Signal<boolean>;
  /** Replace the whole value and persist it. */
  set(value: T): void;
  /** Functional update + persist. */
  update(updater: (current: T) => T): void;
  /** Shallow-merge a partial value + persist. */
  patch(partial: Partial<T>): void;
  /** Clear the stored document and return to `defaults`. */
  reset(): Promise<void>;
  /** Flush any pending debounced write immediately (useful before export/tests). */
  flush(): Promise<void>;
}

/**
 * The single persistence mechanism for the whole app.
 *
 * `bind()` returns a signal-backed collection whose every mutation is mirrored
 * to IndexedDB (debounced), and which hydrates + migrates itself on creation.
 * Features never talk to IndexedDB directly — they bind a collection and read
 * `value()` / call `set()` | `patch()`.
 */
@Injectable({ providedIn: 'root' })
export class StorageService {
  // IndexedDB only exists in the browser. During the build-time prerender
  // (server platform) every collection stays at its defaults and never touches
  // the DB — client-side hydration then loads the real data.
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly encryption = inject(EncryptionService);

  bind<T>(config: CollectionConfig<T>): PersistentCollection<T> {
    const debounceMs = config.debounceMs ?? 250;
    const value = signal<T>(config.defaults);
    const ready = signal(false);
    const isBrowser = this.isBrowser;
    const encryption = this.encryption;

    let pending: ReturnType<typeof setTimeout> | null = null;
    let lastWrite: Promise<void> = Promise.resolve();

    const schedulePersist = (data: T): void => {
      if (!isBrowser) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        lastWrite = writeEnvelope(config.key, config.version, data, encryption);
      }, debounceMs);
    };

    const flush = async (): Promise<void> => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
        lastWrite = writeEnvelope(config.key, config.version, value(), encryption);
      }
      await lastWrite;
    };

    const set = (next: T): void => {
      value.set(next);
      schedulePersist(next);
    };
    const update = (updater: (current: T) => T): void => set(updater(value()));
    const patch = (partial: Partial<T>): void => set({ ...value(), ...partial });

    const reset = async (): Promise<void> => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      value.set(config.defaults);
      if (!isBrowser) return;
      const db = await getDb();
      await db.delete('collections', config.key);
    };

    // No IndexedDB during prerender — keep defaults and mark ready immediately.
    if (!isBrowser) {
      ready.set(true);
      return {
        value: value.asReadonly(),
        ready: ready.asReadonly(),
        set,
        update,
        patch,
        reset,
        flush,
      };
    }

    // Hydrate + migrate asynchronously; never blocks first paint.
    void (async () => {
      try {
        // When encryption is on, nothing is read until the session is unlocked.
        // This is what keeps the lock screen in front of the data rather than
        // beside it — stores stay at their defaults until the key exists.
        await encryption.whenReadable();

        const db = await getDb();
        const envelope = (await db.get('collections', config.key)) as
          StoredEnvelope<unknown> | undefined;
        const stored = envelope
          ? ({
              ...envelope,
              data: await encryption.openIfSealed<T>(envelope.data),
            } as StoredEnvelope<T>)
          : undefined;

        if (stored) {
          if (stored.version === config.version) {
            value.set(stored.data);
          } else if (config.migrate) {
            const migrated = config.migrate(stored.data, stored.version);
            value.set(migrated);
            await writeEnvelope(config.key, config.version, migrated, encryption);
          } else {
            // No migrator supplied for an older record — keep defaults, leave record intact.
            value.set(config.defaults);
          }
        }
      } catch (err) {
        console.error(`[StorageService] Failed to hydrate "${config.key}"`, err);
      } finally {
        ready.set(true);
      }
    })();

    return {
      value: value.asReadonly(),
      ready: ready.asReadonly(),
      set,
      update,
      patch,
      reset,
      flush,
    };
  }
}

async function writeEnvelope<T>(
  key: string,
  version: number,
  data: T,
  encryption: EncryptionService,
): Promise<void> {
  try {
    const db = await getDb();
    // `crypto-meta` is what tells us how to unlock, so it can never be encrypted.
    const payload = key === CRYPTO_META_KEY ? data : await encryption.sealIfEnabled(data);
    await db.put('collections', { version, data: payload, updatedAt: Date.now() }, key);
  } catch (err) {
    console.error(`[StorageService] Failed to persist "${key}"`, err);
  }
}
