import { test, expect, Page } from '@playwright/test';

// The debt-free forecast. Loans that can't be projected are listed with what
// they're missing rather than quietly vanishing from the tab.

/**
 * Add a loan row. Waits on the row count before filling: change detection is
 * zoneless, so `.last()` resolved straight after the click can still point at
 * the previous row and silently overwrite it.
 */
async function addLoan(page: Page, name: string, emi: string) {
  const before = await page.getByTestId('loan-row').count();
  await page.getByTestId('loan-add').click();
  await expect(page.getByTestId('loan-row')).toHaveCount(before + 1);
  await page.getByTestId('loan-name').last().fill(name);
  await page.getByTestId('loan-emi').last().fill(emi);
}

/** ₹30L at 9% with a ₹27,000 instalment — a 20-year home loan. */
async function addHomeLoan(page: Page, name = 'Home loan') {
  await addLoan(page, name, '27000');
  await page.getByTestId('loan-principal').last().fill('3000000');
  await page.getByTestId('loan-rate').last().fill('9');
}

async function openForecast(page: Page) {
  await page.getByRole('tab', { name: 'Forecast' }).click();
}

test.describe('Loan · forecast', () => {
  test('deep-links to the tab and says there is nothing to forecast yet', async ({ page }) => {
    await page.goto('/loan?tab=forecast');
    await expect(page.getByRole('heading', { name: 'Nothing to forecast yet' })).toBeVisible();
  });

  test('projects a debt-free date from the balance, rate and instalment', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    // ₹30L at 9% with a ₹27,000 EMI clears in 240 months.
    await expect(page.getByTestId('forecast-card-0')).toContainText('Baseline');
    await expect(page.getByTestId('forecast-card-0')).toContainText('20y');
    await expect(page.getByTestId('forecast-outstanding')).toContainText('30,00,000');
  });

  test('compares step-up and prepayment against the baseline', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    // Three scenarios: baseline, then two that must both beat it.
    await expect(page.getByTestId('forecast-card-1')).toContainText('Step up');
    await expect(page.getByTestId('forecast-card-2')).toContainText('Prepay');
    await expect(page.getByTestId('forecast-saved-1')).toContainText('saves');
    await expect(page.getByTestId('forecast-saved-2')).toContainText('saves');
    // The baseline is the thing being saved against, so it shows no saving.
    await expect(page.getByTestId('forecast-saved-0')).toHaveCount(0);
  });

  test('a bigger step-up clears the loan sooner', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    await page.getByTestId('forecast-stepup').fill('5');
    const atFive = await page.getByTestId('forecast-card-1').innerText();

    await page.getByTestId('forecast-stepup').fill('20');
    await expect(page.getByTestId('forecast-card-1')).not.toHaveText(atFive);
    await expect(page.getByTestId('forecast-card-1')).toContainText('Step up 20%/yr');
  });

  test('draws a balance curve per scenario', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    const chart = page.getByTestId('forecast-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('svg')).toHaveCount(1);
    // One point per year of the baseline's 20-year run.
    await expect(page.getByTestId('forecast-chart-point-Baseline-0')).toBeVisible();
    await expect(page.getByTestId('forecast-chart-point-Baseline-19')).toBeVisible();
  });

  test('lists an incomplete loan with what it still needs', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await addLoan(page, 'Gold loan', '24000'); // no balance, no rate
    await openForecast(page);

    await expect(page.getByText('These loans need a little more')).toBeVisible();
    await expect(
      page.getByText('needs the balance still outstanding, the interest rate'),
    ).toBeVisible();
    // …and it does not silently vanish: the complete loan still forecasts.
    await expect(page.getByTestId('forecast-card-0')).toBeVisible();
  });

  test('names yearly billing as the blocker, not a missing value', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page, 'Gold loan');
    await page.getByTestId('loan-period').last().getByRole('radio', { name: '/yr' }).click();
    await openForecast(page);

    await expect(page.getByText('needs a monthly instalment (it is billed yearly)')).toBeVisible();
    await expect(page.getByTestId('forecast-card-0')).toHaveCount(0);
  });

  test('picks between loans once more than one is ready', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page, 'Home loan');
    await addHomeLoan(page, 'Car loan');
    await openForecast(page);

    await expect(page.getByTestId('forecast-loan-select')).toBeVisible();
  });

  test('offers no picker when only one loan is ready', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    await expect(page.getByTestId('forecast-loan-select')).toHaveCount(0);
  });

  test('inputs are a scratchpad — they do not survive a reload', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    await page.getByTestId('forecast-stepup').fill('22');
    await expect(page.getByTestId('forecast-card-1')).toContainText('22%');

    await page.waitForTimeout(500); // let the loan itself persist
    await page.goto('/loan?tab=forecast');
    await expect(page.getByTestId('forecast-stepup')).toHaveValue('10'); // back to the default
  });
});

test.describe('Loan · forecast seeded from month history', () => {
  test('seeds the prepayment from what recent months actually left over', async ({ page }) => {
    // Record a month with a real surplus: ₹1,00,000 in, ₹40,000 out.
    await page.goto('/spending?tab=history');
    await page.getByTestId('history-start-fy').click();
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    await page.getByTestId(`history-income-${key}`).fill('100000');
    await page.getByTestId(`history-expenses-${key}`).fill('40000');
    await page.waitForTimeout(500); // debounced write

    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    // ₹60,000 left over, rounded to the slider's ₹5,000 step.
    await expect(page.getByTestId('forecast-use-surplus')).toBeVisible();
    await expect(page.getByTestId('forecast-lump')).toHaveValue('60000');
  });

  test('re-syncs on demand after the slider is moved', async ({ page }) => {
    await page.goto('/spending?tab=history');
    await page.getByTestId('history-start-fy').click();
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    await page.getByTestId(`history-income-${key}`).fill('100000');
    await page.getByTestId(`history-expenses-${key}`).fill('40000');
    await page.waitForTimeout(500);

    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    await page.getByTestId('forecast-lump').fill('5000');
    await page.getByTestId('forecast-use-surplus').click();
    await expect(page.getByTestId('forecast-lump')).toHaveValue('60000');
  });

  test('offers no seed when nothing has been tracked', async ({ page }) => {
    await page.goto('/loan');
    await addHomeLoan(page);
    await openForecast(page);

    await expect(page.getByTestId('forecast-use-surplus')).toHaveCount(0);
  });
});
