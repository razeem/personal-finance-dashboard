import { test, expect, Page } from '@playwright/test';

// The Investing pillar's two calculators: an Inflation Adjuster whose rate is the
// app-wide assumption (Settings → Assumptions), and an NPS projection that reads
// that same rate plus the NPS contribution already declared in this pillar.

/** Read a rupee figure out of a tile/row and return it as a number. */
async function rupees(page: Page, testid: string): Promise<number> {
  const text = await page.getByTestId(testid).innerText();
  const match = text.replace(/,/g, '').match(/₹\s*([\d.]+)/);
  expect(match, `no rupee figure in ${testid}: ${text}`).not.toBeNull();
  return Number(match![1]);
}

async function openAssumptionsTab(page: Page) {
  await page.goto('/');
  await page.getByTestId('avatar-menu').click();
  await page.getByTestId('open-settings').click();
  await page.getByRole('tab', { name: 'Assumptions' }).click();
  await expect(page.getByTestId('assumption-inflation')).toBeVisible();
}

test.describe('Inflation adjuster', () => {
  test('deep-links to the tab and forecasts the selected year', async ({ page }) => {
    const targetYear = new Date().getFullYear() + 20;

    await page.goto('/investing?tab=inflation');
    await page.getByTestId('inflation-amount').fill('2000000');
    await page.getByTestId('inflation-year').fill(String(targetYear));

    // ₹20,00,000 twenty years out at the default 6% ≈ ₹6,23,609 in today's money,
    // and would cost ≈ ₹64,14,271 by then.
    await expect(page.getByTestId('inflation-present-value')).toContainText('6,23,609');
    await expect(page.getByTestId('inflation-future-cost')).toContainText('64,14,271');
    await expect(page.getByTestId('inflation-erosion')).toContainText('68.8');
    // The selected year is a row in the forecast table.
    await expect(page.getByTestId(`inflation-row-${targetYear}`)).toContainText('6,23,609');
  });

  test('a longer horizon erodes more value', async ({ page }) => {
    const baseYear = new Date().getFullYear();
    await page.goto('/investing?tab=inflation');
    await page.getByTestId('inflation-amount').fill('1000000');

    await page.getByTestId('inflation-year').fill(String(baseYear + 10));
    const worthIn10 = await rupees(page, 'inflation-present-value');

    await page.getByTestId('inflation-year').fill(String(baseYear + 30));
    const worthIn30 = await rupees(page, 'inflation-present-value');

    expect(worthIn30).toBeLessThan(worthIn10);
    expect(worthIn10).toBeLessThan(1_000_000);
  });

  test('the inflation rate is a shared, persisted assumption', async ({ page }) => {
    await page.goto('/investing?tab=inflation');
    await page.getByTestId('inflation-rate').fill('9');

    // The NPS calculator reads the same assumption…
    await page.getByRole('tab', { name: 'NPS calculator' }).click();
    await expect(page.getByTestId('nps-inflation-rate')).toHaveValue('9');

    // …and it survives a reload (persisted in IndexedDB).
    await page.waitForTimeout(500); // debounced write
    await page.reload();
    await expect(page.getByTestId('nps-inflation-rate')).toHaveValue('9');

    // The settings editor shows the same figure.
    await openAssumptionsTab(page);
    await expect(page.getByTestId('assumption-inflation')).toHaveValue('9');
  });

  test('editing the rate in settings flows into the calculators', async ({ page }) => {
    await openAssumptionsTab(page);
    await page.getByTestId('assumption-inflation').fill('4');
    await page.getByTestId('assumption-inflation').blur();
    await page.waitForTimeout(500);

    await page.goto('/investing?tab=inflation');
    await expect(page.getByTestId('inflation-rate')).toHaveValue('4');
  });
});

test.describe('Contributions', () => {
  test('a yearly contribution counts as its monthly twelfth', async ({ page }) => {
    await page.goto('/investing');

    await page.getByTestId('invest-voluntary-add').click();
    await page.getByTestId('invest-voluntary-type').last().fill('PPF');
    await page.getByTestId('invest-voluntary-value').last().fill('120000');

    // Monthly by default: the whole ₹1,20,000 lands in the monthly total
    // (on top of the ₹1,850 default EPF).
    await expect(page.getByTestId('investing-total-tile')).toContainText('1,21,850');

    await page
      .getByTestId('invest-voluntary-period')
      .last()
      .getByRole('radio', { name: '/yr' })
      .click();

    // Flipped to yearly → ₹10,000/mo, and the list footer agrees with the tile.
    await expect(page.getByTestId('investing-total-tile')).toContainText('11,850');
    await expect(page.getByTestId('invest-voluntary-total')).toContainText('10,000');
  });
});

test.describe('NPS calculator', () => {
  test('projects the corpus, lumpsum and pension, then discounts them to today', async ({
    page,
  }) => {
    await page.goto('/investing?tab=nps');
    await page.getByTestId('nps-contribution').fill('5000');
    await page.getByTestId('nps-current-age').fill('30');
    await page.getByTestId('nps-retirement-age').fill('60');
    await page.getByTestId('nps-return').fill('10');
    await page.getByTestId('nps-annuity-share').fill('40');
    await page.getByTestId('nps-annuity-rate').fill('6');

    const corpus = await rupees(page, 'nps-corpus');
    const invested = await rupees(page, 'nps-invested');
    const lumpsum = await rupees(page, 'nps-lumpsum');
    const pension = await rupees(page, 'nps-pension');

    // ₹5,000/month for 30 years at 10% ≈ ₹1.14 crore, of which ₹18L is contributions.
    expect(invested).toBe(1_800_000);
    expect(corpus).toBeGreaterThan(11_000_000);
    expect(corpus).toBeLessThan(12_000_000);
    // 40% buys the annuity → 60% is the lumpsum; the pension is 6%/yr of the rest.
    expect(lumpsum / corpus).toBeCloseTo(0.6, 2);
    expect(pension).toBeCloseTo((corpus * 0.4 * 0.06) / 12, -1);

    // The inflation-adjusted view is strictly smaller than the nominal figures.
    const realLumpsum = await rupees(page, 'nps-real-lumpsum');
    const realPension = await rupees(page, 'nps-real-pension');
    expect(realLumpsum).toBeLessThan(lumpsum);
    expect(realPension).toBeLessThan(pension);
    await expect(page.getByTestId('nps-real-verdict')).toContainText('buys today');

    // Year-by-year schedule covers every contributing year.
    await expect(page.getByTestId('nps-year-1')).toBeVisible();
    await expect(page.getByTestId('nps-year-30')).toBeVisible();
  });

  test('a higher inflation assumption shrinks the today’s-money payout', async ({ page }) => {
    await page.goto('/investing?tab=nps');
    await page.getByTestId('nps-inflation-rate').fill('4');
    const at4 = await rupees(page, 'nps-real-lumpsum');

    await page.getByTestId('nps-inflation-rate').fill('9');
    const at9 = await rupees(page, 'nps-real-lumpsum');

    expect(at9).toBeLessThan(at4);
  });

  test('seeds the contribution from the NPS declared in this pillar', async ({ page }) => {
    // Declare an NPS line item under Contributions.
    await page.goto('/investing');
    await page.getByTestId('invest-voluntary-add').click();
    await page.getByTestId('invest-voluntary-type').last().fill('NPS Tier-I');
    await page.getByTestId('invest-voluntary-value').last().fill('7500');
    await page.waitForTimeout(500); // debounced write

    // On the next visit the calculator picks it up automatically.
    await page.goto('/investing?tab=nps');
    await expect(page.getByTestId('nps-contribution')).toHaveValue('7500');
    await expect(page.getByTestId('nps-use-declared')).toBeVisible();
  });
});
