import { test, expect, Page } from '@playwright/test';
import type { CDPSession } from '@playwright/test';

// Unlocking with a passkey (WebAuthn PRF), against Chromium's virtual
// authenticator. The point of these tests is the promise the design makes:
// a passkey is a convenience, and losing it never loses the data.

const PASSPHRASE = 'correct horse battery staple';

/**
 * A platform authenticator that supports PRF and auto-approves user presence,
 * so no human has to touch a sensor mid-test.
 */
async function addAuthenticator(page: Page): Promise<{ client: CDPSession; id: string }> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = (await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  } as never)) as { authenticatorId: string };
  return { client, id: authenticatorId };
}

async function openSettings(page: Page, tab: string) {
  await page.getByTestId('avatar-menu').click();
  await page.getByTestId('open-settings').click();
  await page.getByRole('tab', { name: tab }).click();
}

async function enableEncryption(page: Page) {
  await openSettings(page, 'Encryption');
  await page.getByTestId('encryption-passphrase').fill(PASSPHRASE);
  await page.getByTestId('encryption-confirm').fill(PASSPHRASE);
  await page.getByTestId('encryption-enable').click();
  await expect(page.getByTestId('encryption-status')).toBeVisible({ timeout: 20_000 });
}

async function setGross(page: Page, amount: string) {
  await page.goto('/income');
  await page.getByTestId('income-gross').fill(amount);
  await page.waitForTimeout(500); // debounced write
}

test.describe('Encryption · passkey unlock', () => {
  test('adds a passkey and unlocks with it instead of the passphrase', async ({ page }) => {
    await setGross(page, '123456');
    const { client, id } = await addAuthenticator(page);

    await enableEncryption(page);
    await page.getByTestId('encryption-add-biometric').click();
    await expect(page.getByText('Passkey added.')).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByTestId('lock-biometric')).toBeVisible();
    await page.getByTestId('lock-biometric').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 30_000 });

    await page.getByTestId('nav-income').click();
    await expect(page.getByTestId('income-gross')).toHaveValue('123456');

    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id } as never);
  });

  test('the passphrase still works once a passkey exists', async ({ page }) => {
    await setGross(page, '123456');
    const { client, id } = await addAuthenticator(page);

    await enableEncryption(page);
    await page.getByTestId('encryption-add-biometric').click();
    await expect(page.getByText('Passkey added.')).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await page.getByTestId('lock-passphrase').fill(PASSPHRASE);
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 20_000 });

    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id } as never);
  });

  /**
   * The reason the master key is wrapped twice rather than derived from the
   * passkey: losing the device must not lose the data.
   */
  test('losing the passkey does not lose the data', async ({ page }) => {
    await setGross(page, '123456');
    const { client, id } = await addAuthenticator(page);

    await enableEncryption(page);
    await page.getByTestId('encryption-add-biometric').click();
    await expect(page.getByText('Passkey added.')).toBeVisible({ timeout: 30_000 });

    // The authenticator is gone — as if the phone were lost.
    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id } as never);
    await page.reload();

    await page.getByTestId('lock-passphrase').fill(PASSPHRASE);
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 20_000 });

    await page.getByTestId('nav-income').click();
    await expect(page.getByTestId('income-gross')).toHaveValue('123456');
  });

  test('removes the passkey and stops offering it', async ({ page }) => {
    await page.goto('/');
    const { client, id } = await addAuthenticator(page);

    await enableEncryption(page);
    await page.getByTestId('encryption-add-biometric').click();
    await expect(page.getByTestId('encryption-biometric-on')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('encryption-remove-biometric').click();
    await expect(page.getByTestId('encryption-add-biometric')).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByTestId('lock-passphrase')).toBeVisible();
    await expect(page.getByTestId('lock-biometric')).toHaveCount(0);

    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id } as never);
  });

  test('offers no passkey option on a device without an authenticator', async ({ page }) => {
    await page.goto('/');
    await enableEncryption(page);
    // No virtual authenticator was added, so there is nothing to offer.
    await expect(page.getByTestId('encryption-add-biometric')).toHaveCount(0);
  });
});
