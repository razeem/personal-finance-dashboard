import { test, expect } from '@playwright/test';

// These assert the static prerendered (SSG) output directly — the raw HTML the
// server sends before any JavaScript runs — which is exactly what a crawler sees.

test('indexed route ships real content + per-page metadata in the raw HTML', async ({
  request,
}) => {
  const res = await request.get('/tax');
  expect(res.status()).toBe(200);
  const html = await res.text();

  // Real prerendered content, not an empty <app-root> shell.
  expect(html).toMatch(/New Regime/i);
  // Per-route title + canonical + JSON-LD baked in, resolved at prerender time.
  expect(html).toContain('India Income Tax Calculator');
  expect(html).toContain(
    '<link rel="canonical" href="https://razeem.github.io/personal-finance-dashboard/tax/"',
  );
  expect(html).toContain('application/ld+json');
  // Indexed pages carry no robots directive.
  expect(html).not.toContain('name="robots"');
});

test('private pillar is prerendered (HTTP 200) but marked noindex', async ({ request }) => {
  const res = await request.get('/income');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('content="noindex,follow"');
});

test('sitemap.xml and robots.txt are served', async ({ request }) => {
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain('/tax/');

  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Sitemap:');
});

test('app hydrates and stays interactive after prerender', async ({ page }) => {
  await page.goto('/tax');
  // Prerendered content is present immediately.
  await expect(page.getByTestId('tax-total-tile')).toBeVisible();

  // Interactivity proves hydration wired up: client-side nav + an IndexedDB-backed
  // edit both work after the static HTML is taken over by Angular.
  await page.getByTestId('nav-loan').click();
  await expect(page).toHaveURL(/\/loan$/);
  await page.getByTestId('loan-add').click();
  await page.getByTestId('loan-emi').first().fill('15000');
  await expect(page.getByTestId('loan-total-tile')).toContainText('15,000');
});
