import { test, expect, Page } from '@playwright/test';

// At-rest encryption over IndexedDB. The tests that matter are the ones that
// look at what is actually on disk, not just at what the UI says.

const PASSPHRASE = 'correct horse battery staple';

async function openSettings(page: Page, tab: string) {
  await page.getByTestId('avatar-menu').click();
  await page.getByTestId('open-settings').click();
  await page.getByRole('tab', { name: tab }).click();
}

/**
 * Navigate WITHOUT reloading. A full `page.goto` would relock the session —
 * correctly, since the key only ever lives in memory — so in-app checks after
 * an unlock have to go through the router.
 */
async function navigate(page: Page, pillar: string) {
  await page.getByTestId(`nav-${pillar}`).click();
}

async function enableEncryption(page: Page, passphrase = PASSPHRASE) {
  await openSettings(page, 'Encryption');
  await page.getByTestId('encryption-passphrase').fill(passphrase);
  await page.getByTestId('encryption-confirm').fill(passphrase);
  await page.getByTestId('encryption-enable').click();
  await expect(page.getByTestId('encryption-status')).toBeVisible({ timeout: 20_000 });
}

/** Read a collection straight out of IndexedDB, bypassing the app entirely. */
async function rawCollection(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (collectionKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('helper-tools-db');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('collections', 'readonly');
      const req = tx.objectStore('collections').get(collectionKey);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }, key);
}

async function setGross(page: Page, amount: string) {
  await page.goto('/income');
  await page.getByTestId('income-gross').fill(amount);
  await page.waitForTimeout(500); // debounced write
}

test.describe('Encryption · turning it on', () => {
  test('warns that the passphrase cannot be reset', async ({ page }) => {
    await page.goto('/');
    await openSettings(page, 'Encryption');
    await expect(page.getByTestId('encryption-warning')).toContainText(
      'no way to reset this passphrase',
    );
  });

  test('refuses a passphrase that is too short or mistyped', async ({ page }) => {
    await page.goto('/');
    await openSettings(page, 'Encryption');

    await page.getByTestId('encryption-passphrase').fill('short');
    await page.getByTestId('encryption-confirm').fill('short');
    await expect(page.getByTestId('encryption-enable')).toBeDisabled();

    await page.getByTestId('encryption-passphrase').fill(PASSPHRASE);
    await page.getByTestId('encryption-confirm').fill('something else');
    await expect(page.getByTestId('encryption-enable')).toBeDisabled();
  });

  test('encrypts what was already stored, on disk', async ({ page }) => {
    await setGross(page, '123456');

    // Plaintext to begin with: the figure is readable in the raw record.
    const before = await rawCollection(page, 'finance');
    expect(JSON.stringify(before)).toContain('123456');

    await enableEncryption(page);

    // …and unreadable afterwards, replaced by a versioned iv/ct payload.
    const after = (await rawCollection(page, 'finance')) as { data: Record<string, unknown> };
    expect(JSON.stringify(after)).not.toContain('123456');
    expect(after.data).toHaveProperty('iv');
    expect(after.data).toHaveProperty('ct');
  });

  test('leaves the crypto metadata itself readable', async ({ page }) => {
    await page.goto('/');
    await enableEncryption(page);

    // Encrypting the record that says how to decrypt would lock the key inside.
    const meta = (await rawCollection(page, 'crypto-meta')) as {
      data: { enabled: boolean; keys: { kind: string }[] };
    };
    expect(meta.data.enabled).toBe(true);
    expect(meta.data.keys[0].kind).toBe('passphrase');
  });
});

test.describe('Encryption · the lock', () => {
  test('locks on reload and hides the app behind the lock screen', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);
    await page.reload();

    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await expect(page.getByTestId('lock-passphrase')).toBeVisible();
  });

  test('unlocks with the passphrase and the data is intact', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);
    await page.reload();

    await page.getByTestId('lock-passphrase').fill(PASSPHRASE);
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 20_000 });

    await navigate(page, 'income');
    await expect(page.getByTestId('income-gross')).toHaveValue('123456');
  });

  test('a fresh page load locks again — the key only lives in memory', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);
    await page.reload();
    await page.getByTestId('lock-passphrase').fill(PASSPHRASE);
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 20_000 });

    // Navigating with a full load starts a new page: locked again.
    await page.goto('/income');
    await expect(page.getByTestId('lock-screen')).toBeVisible();
  });

  test('rejects the wrong passphrase and stays locked', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);
    await page.reload();

    await page.getByTestId('lock-passphrase').fill('not the passphrase');
    await page.getByTestId('lock-submit').click();

    await expect(page.getByTestId('lock-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('lock-screen')).toBeVisible();
  });

  test('locks again on demand', async ({ page }) => {
    await page.goto('/');
    await enableEncryption(page);
    await page.getByTestId('encryption-lock-now').click();
    await expect(page.getByTestId('lock-screen')).toBeVisible();
  });
});

test.describe('Encryption · lifecycle', () => {
  test('changes the passphrase without re-encrypting the data', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);

    // The settings dialog is still open from enabling.
    await page.getByTestId('encryption-current').fill(PASSPHRASE);
    await page.getByTestId('encryption-next').fill('a whole new passphrase');
    await page.getByTestId('encryption-change').click();
    await expect(page.getByText('Passphrase changed.')).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await page.getByTestId('lock-passphrase').fill('a whole new passphrase');
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 20_000 });

    await navigate(page, 'income');
    await expect(page.getByTestId('income-gross')).toHaveValue('123456');
  });

  test('turning it off decrypts everything back to plain storage', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);

    await page.getByTestId('encryption-disable-passphrase').fill(PASSPHRASE);
    await page.getByTestId('encryption-disable').click();
    await expect(page.getByTestId('encryption-enable')).toBeVisible({ timeout: 20_000 });

    const raw = await rawCollection(page, 'finance');
    expect(JSON.stringify(raw)).toContain('123456');

    // …and a reload no longer asks for anything.
    await page.reload();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0);
    await page.goto('/income');
    await expect(page.getByTestId('income-gross')).toHaveValue('123456');
  });
});

test.describe('Encryption · data transfer', () => {
  test('exports a plaintext code even while encrypted, and says so', async ({ page }) => {
    await setGross(page, '123456');
    await enableEncryption(page);

    await page.getByRole('tab', { name: 'Transfer data' }).click();
    await expect(page.getByTestId('transfer-plaintext-warning')).toBeVisible();

    await page.getByTestId('transfer-generate').click();
    const code = await page.getByTestId('transfer-export-code').inputValue();
    expect(code.startsWith('PFD1:')).toBe(true);
    // A transfer code has to be readable by a device that has never seen this
    // passphrase, so it is deliberately not encrypted.
    expect(code.length).toBeGreaterThan(50);
  });
});
