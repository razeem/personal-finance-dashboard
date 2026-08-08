import { test, expect } from '@playwright/test';

test('serves the dashboard at the root and shows pillars', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('pillar-income')).toBeVisible();
  await expect(page.getByTestId('pillar-tax')).toBeVisible();
  await expect(page.getByTestId('pillar-saving')).toBeVisible();
});

test('sidebar navigates between pillars', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-income').click();
  await expect(page).toHaveURL(/\/income$/);
  await page.getByTestId('nav-tax').click();
  await expect(page).toHaveURL(/\/tax$/);
  await page.getByTestId('nav-spending').click();
  await expect(page).toHaveURL(/\/spending$/);
});

test('saving pillar sizes an emergency fund from the essential expense', async ({ page }) => {
  await page.goto('/saving');
  await expect(page.getByTestId('saving-minimum-tile')).toBeVisible();
  // Three selectable tiers (3× / 6× / 12×); 6× is the default.
  await expect(page.getByTestId('saving-tier-3')).toBeVisible();
  await expect(page.getByTestId('saving-tier-6')).toHaveAttribute('aria-pressed', 'true');
  // Picking a tier updates the target-fund label.
  await page.getByTestId('saving-tier-12').click();
  await expect(page.getByTestId('saving-target-tile')).toContainText('12×');
});

test('loan EMIs support monthly/yearly and roll into a monthly total', async ({ page }) => {
  await page.goto('/loan');
  await page.getByTestId('loan-add').click();
  await page.getByTestId('loan-emi').first().fill('15000'); // defaults to monthly
  await expect(page.getByTestId('loan-total-tile')).toContainText('15,000');
});

test('insurance and investing are live declaration pillars', async ({ page }) => {
  await page.goto('/investing');
  // EPF (mandatory) defaults to ₹1,850/mo.
  await expect(page.getByTestId('investing-total-tile')).toContainText('1,850');
  await expect(page.getByTestId('invest-mandatory-type').first()).toHaveValue('EPF');
  // Voluntary section exists and is empty by default.
  await expect(page.getByTestId('invest-voluntary-add')).toBeVisible();

  await page.goto('/insurance');
  await expect(page.getByTestId('insurance-total-tile')).toBeVisible();
  await expect(page.getByTestId('insurance-type').first()).toHaveValue('Term insurance');
});

test('insurance premiums support monthly/yearly and convert to a monthly total', async ({
  page,
}) => {
  await page.goto('/insurance');
  // Term insurance defaults to yearly: ₹12,000/yr → ₹1,000/mo.
  await page.getByTestId('insurance-value').first().fill('12000');
  await expect(page.getByTestId('insurance-total-tile')).toContainText('1,000');

  // Switch it to monthly → ₹12,000/mo.
  await page.getByTestId('insurance-period').first().getByText('/mo').click();
  await expect(page.getByTestId('insurance-total-tile')).toContainText('12,000');
});

test('old deep links redirect to the new routes', async ({ page }) => {
  await page.goto('/income-tax');
  await expect(page).toHaveURL(/\/tax$/);
  // /profile and /dashboard now redirect to the root (the home is served at '/').
  await page.goto('/profile');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/$/);
});

test('sidebar collapse persists across reload', async ({ page }) => {
  await page.goto('/');
  const income = page.getByTestId('nav-income');
  await expect(income).toBeVisible();

  await page.getByTestId('nav-toggle').click(); // collapse to rail
  await page.waitForTimeout(500); // debounced preference write

  await page.reload();
  // Rail hides the labels; the label span is not visible though the icon link remains.
  await expect(page.locator('.app-sidenav--rail')).toBeVisible();
});
