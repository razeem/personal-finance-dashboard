import {
  CRYPTO_VERSION,
  CryptoError,
  decryptJson,
  deriveFromPassphrase,
  deriveFromPrf,
  encryptJson,
  generateMasterKey,
  isCryptoAvailable,
  isEncryptedPayload,
  PBKDF2_ITERATIONS,
  randomSalt,
  saltOf,
  unwrapMasterKey,
  wrapMasterKey,
} from './crypto.model';

/**
 * PBKDF2 at the shipped 600k iterations takes ~half a second per call, which
 * would make this file take a minute. Every test derives at a token cost and
 * one test pins the real constant — the iteration count is a parameter of the
 * scheme precisely so it can be dialled down here and up in production.
 */
const FAST = 1_000;

async function passphraseKey(passphrase = 'correct horse battery staple', salt = randomSalt()) {
  return { key: await deriveFromPassphrase(passphrase, salt, FAST), salt };
}

describe('environment', () => {
  it('has WebCrypto under the test runner', () => {
    expect(isCryptoAvailable()).toBe(true);
  });

  it('ships a passphrase cost at or above the OWASP floor', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});

describe('generateMasterKey', () => {
  it('produces an extractable AES-GCM-256 key', async () => {
    const key = await generateMasterKey();
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(true); // it has to be, to be wrapped
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
  });

  it('is different every time', async () => {
    const [a, b] = await Promise.all([generateMasterKey(), generateMasterKey()]);
    const raw = async (k: CryptoKey) =>
      new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', k)).join(',');
    expect(await raw(a)).not.toBe(await raw(b));
  });
});

describe('randomSalt', () => {
  it('is 16 bytes and never repeats', () => {
    const a = randomSalt();
    expect(a).toHaveLength(16);
    expect(a.join(',')).not.toBe(randomSalt().join(','));
  });
});

describe('encryptJson / decryptJson', () => {
  it('round-trips an object', async () => {
    const key = await generateMasterKey();
    const value = { gross: 100_000, needs: ['rent', 'food'], nested: { ok: true } };
    expect(await decryptJson(await encryptJson(value, key), key)).toEqual(value);
  });

  it('round-trips the awkward values JSON still has to carry', async () => {
    const key = await generateMasterKey();
    for (const value of [null, 0, '', false, [], {}, '₹1,00,000 · Apr→Mar']) {
      expect(await decryptJson(await encryptJson(value, key), key)).toEqual(value);
    }
  });

  it('uses a fresh IV every time, so the same input never yields the same bytes', async () => {
    const key = await generateMasterKey();
    const a = await encryptJson({ same: 'value' }, key);
    const b = await encryptJson({ same: 'value' }, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('stamps the payload with the schema version', async () => {
    const key = await generateMasterKey();
    expect((await encryptJson({}, key)).v).toBe(CRYPTO_VERSION);
  });

  it('leaves nothing readable in the ciphertext', async () => {
    const key = await generateMasterKey();
    const payload = await encryptJson({ secret: 'MySalaryIs100000' }, key);
    expect(JSON.stringify(payload)).not.toContain('MySalaryIs100000');
    expect(atob(payload.ct)).not.toContain('secret');
  });

  it('refuses the wrong key rather than returning nonsense', async () => {
    const payload = await encryptJson({ a: 1 }, await generateMasterKey());
    await expect(decryptJson(payload, await generateMasterKey())).rejects.toMatchObject({
      name: 'CryptoError',
      code: 'bad-key',
    });
  });

  it('detects a tampered ciphertext — GCM authenticates', async () => {
    const key = await generateMasterKey();
    const payload = await encryptJson({ amount: 100 }, key);
    const bytes = atob(payload.ct).split('');
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    const tampered = { ...payload, ct: btoa(bytes.join('')) };

    await expect(decryptJson(tampered, key)).rejects.toMatchObject({ code: 'bad-key' });
  });

  it('rejects a payload from a newer schema instead of guessing', async () => {
    const key = await generateMasterKey();
    const payload = { ...(await encryptJson({}, key)), v: CRYPTO_VERSION + 1 };
    await expect(decryptJson(payload, key)).rejects.toMatchObject({ code: 'version' });
  });

  it('rejects something that was never a payload', async () => {
    const key = await generateMasterKey();
    await expect(decryptJson({ gross: 1 } as unknown as never, key)).rejects.toMatchObject({
      code: 'corrupt',
    });
  });
});

describe('isEncryptedPayload', () => {
  it('recognises a real payload', async () => {
    expect(isEncryptedPayload(await encryptJson({ a: 1 }, await generateMasterKey()))).toBe(true);
  });

  it('does not mistake plaintext state for ciphertext', () => {
    expect(isEncryptedPayload({ income: { gross: 100_000 } })).toBe(false);
    expect(isEncryptedPayload({ v: 1 })).toBe(false); // version alone is not enough
    expect(isEncryptedPayload(null)).toBe(false);
    expect(isEncryptedPayload('PFD1:xyz')).toBe(false);
    expect(isEncryptedPayload([])).toBe(false);
  });
});

describe('deriveFromPassphrase', () => {
  it('is deterministic for the same passphrase and salt', async () => {
    const salt = randomSalt();
    const master = await generateMasterKey();
    const a = await deriveFromPassphrase('hunter2', salt, FAST);
    const b = await deriveFromPassphrase('hunter2', salt, FAST);

    // Two derivations are the same key if one can open what the other wrapped.
    const wrapped = await wrapMasterKey(master, a, 'passphrase', salt, { iterations: FAST });
    await expect(unwrapMasterKey(wrapped, b)).resolves.toBeDefined();
  });

  it('gives a different key for a different salt', async () => {
    const master = await generateMasterKey();
    const saltA = randomSalt();
    const wrapped = await wrapMasterKey(
      master,
      await deriveFromPassphrase('hunter2', saltA, FAST),
      'passphrase',
      saltA,
      { iterations: FAST },
    );
    const other = await deriveFromPassphrase('hunter2', randomSalt(), FAST);
    await expect(unwrapMasterKey(wrapped, other)).rejects.toMatchObject({ code: 'bad-key' });
  });

  it('gives a different key for a different iteration count', async () => {
    const master = await generateMasterKey();
    const salt = randomSalt();
    const wrapped = await wrapMasterKey(
      master,
      await deriveFromPassphrase('hunter2', salt, FAST),
      'passphrase',
      salt,
      { iterations: FAST },
    );
    const other = await deriveFromPassphrase('hunter2', salt, FAST * 2);
    await expect(unwrapMasterKey(wrapped, other)).rejects.toMatchObject({ code: 'bad-key' });
  });

  it('refuses an empty passphrase', async () => {
    await expect(deriveFromPassphrase('', randomSalt(), FAST)).rejects.toMatchObject({
      code: 'weak-passphrase',
    });
  });

  it('is not usable for encryption directly — it only wraps', async () => {
    const { key } = await passphraseKey();
    expect(key.usages).toEqual(expect.arrayContaining(['wrapKey', 'unwrapKey']));
    expect(key.usages).not.toContain('encrypt');
    expect(key.extractable).toBe(false);
  });
});

describe('deriveFromPrf', () => {
  const prf = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

  it('round-trips a master key wrapped under a PRF-derived key', async () => {
    const master = await generateMasterKey();
    const output = prf();
    const salt = randomSalt();

    const wrapped = await wrapMasterKey(master, await deriveFromPrf(output, salt), 'prf', salt);
    const recovered = await unwrapMasterKey(wrapped, await deriveFromPrf(output, salt));

    const payload = await encryptJson({ ok: 1 }, master);
    expect(await decryptJson(payload, recovered)).toEqual({ ok: 1 });
  });

  it('rejects a different PRF output — a different passkey cannot open it', async () => {
    const master = await generateMasterKey();
    const salt = randomSalt();
    const wrapped = await wrapMasterKey(master, await deriveFromPrf(prf(), salt), 'prf', salt);
    await expect(unwrapMasterKey(wrapped, await deriveFromPrf(prf(), salt))).rejects.toMatchObject({
      code: 'bad-key',
    });
  });
});

describe('wrapMasterKey / unwrapMasterKey', () => {
  it('recovers a key that decrypts what the original encrypted', async () => {
    const master = await generateMasterKey();
    const payload = await encryptJson({ gross: 100_000 }, master);
    const { key, salt } = await passphraseKey();

    const wrapped = await wrapMasterKey(master, key, 'passphrase', salt, { iterations: FAST });
    const recovered = await unwrapMasterKey(wrapped, key);

    expect(await decryptJson(payload, recovered)).toEqual({ gross: 100_000 });
  });

  it('records the parameters needed to reopen it', async () => {
    const master = await generateMasterKey();
    const { key, salt } = await passphraseKey();
    const wrapped = await wrapMasterKey(master, key, 'passphrase', salt, {
      iterations: FAST,
      label: 'My passphrase',
    });

    expect(wrapped.v).toBe(CRYPTO_VERSION);
    expect(wrapped.kind).toBe('passphrase');
    expect(wrapped.iterations).toBe(FAST);
    expect(wrapped.label).toBe('My passphrase');
    expect(saltOf(wrapped)).toEqual(salt);
  });

  it('never stores the master key in the clear', async () => {
    const master = await generateMasterKey();
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', master));
    const { key, salt } = await passphraseKey();
    const wrapped = await wrapMasterKey(master, key, 'passphrase', salt, { iterations: FAST });

    expect(wrapped.key).not.toBe(btoa(String.fromCharCode(...raw)));
    expect(atob(wrapped.key).length).toBeGreaterThan(raw.length); // ciphertext + GCM tag
  });

  it('rejects the wrong passphrase with bad-key', async () => {
    const master = await generateMasterKey();
    const salt = randomSalt();
    const wrapped = await wrapMasterKey(
      master,
      await deriveFromPassphrase('right', salt, FAST),
      'passphrase',
      salt,
      { iterations: FAST },
    );
    const wrong = await deriveFromPassphrase('wrong', salt, FAST);
    await expect(unwrapMasterKey(wrapped, wrong)).rejects.toMatchObject({ code: 'bad-key' });
  });

  it('rejects a record from a newer schema', async () => {
    const master = await generateMasterKey();
    const { key, salt } = await passphraseKey();
    const wrapped = await wrapMasterKey(master, key, 'passphrase', salt, { iterations: FAST });
    await expect(unwrapMasterKey({ ...wrapped, v: CRYPTO_VERSION + 1 }, key)).rejects.toMatchObject(
      { code: 'version' },
    );
  });

  it('rejects a corrupt record', async () => {
    const { key } = await passphraseKey();
    await expect(
      unwrapMasterKey(
        { v: CRYPTO_VERSION, kind: 'passphrase', key: 'not base64!!', iv: '@@', salt: '' },
        key,
      ),
    ).rejects.toBeInstanceOf(CryptoError);
  });
});

/**
 * The reason the master key is wrapped rather than derived: a passkey can be
 * lost, and the data must not go with it.
 */
describe('double-wrapping', () => {
  it('opens the same master key from either method', async () => {
    const master = await generateMasterKey();
    const payload = await encryptJson({ gross: 100_000 }, master);

    const passSalt = randomSalt();
    const prfSalt = randomSalt();
    const prfOutput = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const byPassphrase = await wrapMasterKey(
      master,
      await deriveFromPassphrase('backup phrase', passSalt, FAST),
      'passphrase',
      passSalt,
      { iterations: FAST },
    );
    const byPrf = await wrapMasterKey(
      master,
      await deriveFromPrf(prfOutput, prfSalt),
      'prf',
      prfSalt,
      { label: 'Touch ID' },
    );

    const viaPassphrase = await unwrapMasterKey(
      byPassphrase,
      await deriveFromPassphrase('backup phrase', saltOf(byPassphrase), FAST),
    );
    const viaPrf = await unwrapMasterKey(byPrf, await deriveFromPrf(prfOutput, saltOf(byPrf)));

    expect(await decryptJson(payload, viaPassphrase)).toEqual({ gross: 100_000 });
    expect(await decryptJson(payload, viaPrf)).toEqual({ gross: 100_000 });
  });

  it('survives losing the passkey — the passphrase still opens everything', async () => {
    const master = await generateMasterKey();
    const payload = await encryptJson({ gross: 100_000 }, master);
    const salt = randomSalt();
    const byPassphrase = await wrapMasterKey(
      master,
      await deriveFromPassphrase('backup phrase', salt, FAST),
      'passphrase',
      salt,
      { iterations: FAST },
    );

    // The passkey record is gone; only the passphrase record remains.
    const recovered = await unwrapMasterKey(
      byPassphrase,
      await deriveFromPassphrase('backup phrase', saltOf(byPassphrase), FAST),
    );
    expect(await decryptJson(payload, recovered)).toEqual({ gross: 100_000 });
  });

  it('rewraps under a new passphrase without re-encrypting anything', async () => {
    const master = await generateMasterKey();
    const payload = await encryptJson({ gross: 100_000 }, master);

    const oldSalt = randomSalt();
    const old = await wrapMasterKey(
      master,
      await deriveFromPassphrase('old', oldSalt, FAST),
      'passphrase',
      oldSalt,
      { iterations: FAST },
    );

    // Changing the passphrase rewraps the same master key…
    const opened = await unwrapMasterKey(old, await deriveFromPassphrase('old', saltOf(old), FAST));
    const newSalt = randomSalt();
    const rotated = await wrapMasterKey(
      opened,
      await deriveFromPassphrase('new', newSalt, FAST),
      'passphrase',
      newSalt,
      { iterations: FAST },
    );

    // …so documents written under the old one still read, untouched.
    const recovered = await unwrapMasterKey(
      rotated,
      await deriveFromPassphrase('new', saltOf(rotated), FAST),
    );
    expect(await decryptJson(payload, recovered)).toEqual({ gross: 100_000 });
    await expect(
      unwrapMasterKey(rotated, await deriveFromPassphrase('old', saltOf(rotated), FAST)),
    ).rejects.toMatchObject({ code: 'bad-key' });
  });
});
