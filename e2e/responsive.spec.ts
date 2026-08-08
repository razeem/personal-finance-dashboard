import { test, expect } from '@playwright/test';

// Phone-sized regression cover. The 12-month salary breakdown packs a month label
// and two outlined ₹-prefixed fields into one row; on a 390px viewport that row
// used to push the page sideways, so below `sm` each month collapses to its own
// stacked card. Anything that scrolls the whole page horizontally is a bug.

const PHONE = { width: 390, height: 844 }; // iPhone 12/13/14 logical viewport

async function pageOverflowsHorizontally(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px of tolerance for sub-pixel rounding in the layout engine.
    return Math.max(doc.scrollWidth, document.body.scrollWidth) > doc.clientWidth + 1;
  });
}

test.describe('Income · 12-month breakdown on a phone', () => {
  test.use({ viewport: PHONE });

  test('the expanded breakdown does not scroll the page sideways', async ({ page }) => {
    await page.goto('/income?tab=minimum');

    // Collapsed to begin with — establish the page is clean before expanding.
    await expect(page.getByTestId('salary-breakdown')).toBeVisible();
    expect(await pageOverflowsHorizontally(page)).toBe(false);

    await page.getByTestId('salary-breakdown').getByRole('button').first().click();
    await expect(page.getByTestId('month-base-0')).toBeVisible();

    expect(await pageOverflowsHorizontally(page)).toBe(false);
  });

  test('each month is a single stacked card, and every field still edits', async ({ page }) => {
    await page.goto('/income?tab=minimum');
    await page.getByTestId('salary-breakdown').getByRole('button').first().click();
    await expect(page.getByTestId('month-base-0')).toBeVisible();

    // All twelve months are rendered, each one card wide.
    await expect(page.getByTestId(/^month-row-/)).toHaveCount(12);
    const card = await page.getByTestId('month-row-0').boundingBox();
    const base = await page.getByTestId('month-base-0').boundingBox();
    const bonus = await page.getByTestId('month-bonus-0').boundingBox();
    expect(card!.width).toBeLessThanOrEqual(PHONE.width);
    // Stacked, not side by side: Bonus starts below Base.
    expect(bonus!.y).toBeGreaterThan(base!.y + base!.height - 1);

    // …and the point of stacking: the amount is actually readable. Squeezed into
    // the old three-across row the Base input was ~51px wide and clipped its own
    // value ("₹ 100C" instead of ₹1,00,000).
    expect(base!.width).toBeGreaterThan(120);

    // The inputs still write through to the shared model.
    await page.getByTestId('month-bonus-11').fill('300000');
    await expect(page.getByTestId('salary-annual-total')).toContainText('15,00,000');
  });

  test('the panel header stacks instead of colliding with its description', async ({ page }) => {
    await page.goto('/income?tab=minimum');
    const header = page.getByTestId('salary-breakdown').getByRole('button').first();
    const title = header.locator('mat-panel-title');
    const description = header.locator('mat-panel-description');

    const t = await title.boundingBox();
    const d = await description.boundingBox();
    // Description sits below the title, not overlapping it in the same row.
    expect(d!.y).toBeGreaterThanOrEqual(t!.y + t!.height - 1);
  });
});

test.describe('Income · 12-month breakdown on a desktop', () => {
  test('keeps the compact one-line-per-month row', async ({ page }) => {
    await page.goto('/income?tab=minimum');
    await page.getByTestId('salary-breakdown').getByRole('button').first().click();
    await expect(page.getByTestId('month-base-0')).toBeVisible();

    const base = await page.getByTestId('month-base-0').boundingBox();
    const bonus = await page.getByTestId('month-bonus-0').boundingBox();
    // Side by side on one line — the `sm`-and-up layout is untouched.
    expect(bonus!.x).toBeGreaterThan(base!.x);
    expect(Math.abs(bonus!.y - base!.y)).toBeLessThan(2);
  });
});
