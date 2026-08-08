import { test, expect, Page } from '@playwright/test';

// The month-history tracker on the Spending pillar. Every month is frozen from
// the shared model and carried forward until the user corrects it; correcting it
// makes it theirs, and nothing overwrites it afterwards.

/** `YYYY-MM` for a month offset from today — the tracker keys rows by this. */
function monthKey(offset = 0): string {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function startTracking(page: Page, mode: 'first-use' | 'fy' = 'fy') {
  await page.goto('/spending?tab=history');
  await page.getByTestId(`history-start-${mode}`).click();
  await expect(page.getByTestId('history-count-tile')).toBeVisible();
}

test.describe('Spending · month history', () => {
  test('deep-links to the tab and asks where tracking begins', async ({ page }) => {
    await page.goto('/spending?tab=history');

    await expect(page.getByTestId('history-start-first-use')).toBeVisible();
    await expect(page.getByTestId('history-start-fy')).toBeVisible();
    await expect(page.getByTestId('history-start-custom')).toBeVisible();
    // Nothing to track yet, so no month rows.
    await expect(page.getByTestId(`history-row-${monthKey()}`)).toHaveCount(0);
  });

  test('starting at the FY lists every month from April to now', async ({ page }) => {
    await startTracking(page, 'fy');

    // The picker is asked once and then gone.
    await expect(page.getByTestId('history-start-fy')).toHaveCount(0);
    await expect(page.getByTestId(`history-row-${monthKey()}`)).toBeVisible();
    await expect(page.getByTestId(`history-row-${monthKey(-1)}`)).toBeVisible();
  });

  test('months are pre-filled and marked carried over until edited', async ({ page }) => {
    await startTracking(page);
    const key = monthKey(-1);

    // Pre-filled from the shared model (default gross is ₹1,00,000/month).
    await expect(page.getByTestId(`history-income-${key}`)).toHaveValue('100000');
    await expect(page.getByTestId(`history-carried-${key}`)).toBeVisible();

    await page.getByTestId(`history-expenses-${key}`).fill('62000');

    // Editing makes it the user's own — the marker goes away.
    await expect(page.getByTestId(`history-carried-${key}`)).toHaveCount(0);
    await expect(page.getByTestId(`history-saved-${key}`)).toContainText('38,000');
  });

  test('an edited month survives a reload', async ({ page }) => {
    await startTracking(page);
    const key = monthKey(-1);

    await page.getByTestId(`history-income-${key}`).fill('123456');
    await page.waitForTimeout(500); // debounced write
    await page.reload();

    await page.goto('/spending?tab=history');
    await expect(page.getByTestId(`history-income-${key}`)).toHaveValue('123456');
    await expect(page.getByTestId(`history-carried-${key}`)).toHaveCount(0);
  });

  test('the spent total rescales the category split proportionally', async ({ page }) => {
    await startTracking(page);
    const key = monthKey(-1);

    // Give the month a shape first: ₹20,000 needs + ₹10,000 wants, alongside
    // whatever else the carried-over snapshot brought with it.
    await page.getByTestId(`history-split-${key}`).getByRole('button').first().click();
    await page.getByTestId(`history-cat-${key}-needs`).fill('20000');
    await page.getByTestId(`history-cat-${key}-wants`).fill('10000');

    const total = Number(await page.getByTestId(`history-expenses-${key}`).inputValue());
    expect(total).toBeGreaterThan(30_000); // the split really does sum to the total

    // Doubling the total doubles every category — the shape is kept, only the size changes.
    await page.getByTestId(`history-expenses-${key}`).fill(String(total * 2));
    await expect(page.getByTestId(`history-cat-${key}-needs`)).toHaveValue('40000');
    await expect(page.getByTestId(`history-cat-${key}-wants`)).toHaveValue('20000');
  });

  test('backfills a month from before tracking started', async ({ page }) => {
    await startTracking(page, 'first-use');
    const earlier = monthKey(-6);

    await page.getByTestId('history-backfill-month').fill(earlier);
    await page.getByTestId('history-backfill-add').click();

    const row = page.getByTestId(`history-row-${earlier}`);
    await expect(row).toBeVisible();
    // Backfilled months are the user's word — not marked as carried over.
    await expect(page.getByTestId(`history-carried-${earlier}`)).toHaveCount(0);
  });

  test('charts appear once there are two months to compare', async ({ page }) => {
    await startTracking(page, 'fy');

    // One recorded month is not a trend.
    await expect(page.getByTestId('history-chart-income')).toHaveCount(0);

    await page.getByTestId(`history-income-${monthKey(-1)}`).fill('100000');
    await page.getByTestId(`history-income-${monthKey(-2)}`).fill('90000');

    const chart = page.getByTestId('history-chart-income');
    await expect(chart).toBeVisible();
    // Dependency-free: it really is inline SVG, one point per recorded month.
    await expect(chart.locator('svg')).toHaveCount(1);
    await expect(page.getByTestId('history-chart-income-point-Income-0')).toBeVisible();
    await expect(page.getByTestId('history-chart-income-point-Income-1')).toBeVisible();

    // …and a stacked bar per month for the expense breakdown. Every category
    // gets a segment; ones with nothing in them are simply zero-height.
    await expect(page.getByTestId('history-chart-breakdown-bar-Needs-0')).toHaveCount(1);
    await expect(page.getByTestId('history-chart-breakdown-bar-Tax-0')).toBeVisible();
    await expect(page.getByTestId('history-chart-breakdown-bar-Tax-1')).toBeVisible();
  });

  test('the financial-year view rolls the months up into one column', async ({ page }) => {
    await startTracking(page, 'fy');
    await page.getByTestId(`history-income-${monthKey(-1)}`).fill('100000');
    await page.getByTestId(`history-income-${monthKey(-2)}`).fill('90000');
    await expect(page.getByTestId('history-chart-income')).toBeVisible();

    await page.getByTestId('history-grain').getByRole('radio', { name: 'Financial year' }).click();

    // Both months belong to one FY, so the line collapses to a single point.
    await expect(page.getByTestId('history-chart-income-point-Income-0')).toBeVisible();
    await expect(page.getByTestId('history-chart-income-point-Income-1')).toHaveCount(0);
  });

  test('a month can be forgotten again', async ({ page }) => {
    await startTracking(page);
    const key = monthKey(-1);

    await page.getByTestId(`history-income-${key}`).fill('55555');
    await expect(page.getByTestId(`history-remove-${key}`)).toBeVisible();
    await page.getByTestId(`history-remove-${key}`).click();

    // The row stays (it is still inside the tracked range) but is blank again.
    await expect(page.getByTestId(`history-carried-${key}`)).toContainText('Not recorded');
  });
});
