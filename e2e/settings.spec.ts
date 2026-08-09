import { test, expect } from '@playwright/test';

const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o2FDEmIY1TCqYfhqAAC/xkAQosL08QAAAABJRU5ErkJggg==',
  'base64',
);

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('avatar-menu').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('profile-name')).toBeVisible();
}

test('profile in the settings dialog persists across reload', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('profile-name').fill('Ada Lovelace');
  await page.getByTestId('profile-email').fill('ada@example.com');
  await page.waitForTimeout(500);

  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('profile-name')).toHaveValue('Ada Lovelace');
  await expect(page.getByTestId('profile-email')).toHaveValue('ada@example.com');
});

test('avatar shows initials from the saved name', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('profile-name').fill('Grace Hopper');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); // close dialog
  await expect(page.getByTestId('avatar-menu')).toContainText('GH');
});

test('uploads, compresses and persists a photo', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('profile-photo-input').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: SAMPLE_PNG,
  });
  await expect(page.getByTestId('profile-photo')).toBeVisible();
  const src = await page.getByTestId('profile-photo').getAttribute('src');
  expect(src).toMatch(/^blob:/);

  await page.waitForTimeout(500);
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('profile-photo')).toBeVisible();
});

test('preferences offers a plain buy-me-a-coffee link', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Preferences' }).click();

  const link = page.getByTestId('buy-me-a-coffee');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://buymeacoffee.com/razeem');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
});

test('theme toggle switches to dark', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.getByTestId('theme-toggle').locator('[value="dark"]').click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});
