import { test, expect, Page } from '@playwright/test';

// The Loan pillar after loans became entities. A name and an instalment is all
// the budget needs; the balance and rate are what a forecast needs, and each row
// says what it is still missing rather than hiding itself.

async function addLoan(page: Page, name: string, emi: string) {
  await page.getByTestId('loan-add').click();
  await page.getByTestId('loan-name').last().fill(name);
  await page.getByTestId('loan-emi').last().fill(emi);
}

test.describe('Loan · declaring a loan', () => {
  test('a name and an instalment is enough for the budget', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Car loan', '15000');

    await expect(page.getByTestId('loan-total-tile')).toContainText('15,000');
    await expect(page.getByTestId('loan-total')).toContainText('15,000');
  });

  test('says what the loan still needs before it can be forecast', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Car loan', '15000');

    const row = page.getByTestId('loan-row').last();
    await expect(row).toContainText('Needs the outstanding balance, the interest rate');
    await expect(page.getByTestId('loan-ready')).toHaveCount(0);
  });

  test('becomes forecast-ready once the balance and rate are in', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Home loan', '27000');
    await page.getByTestId('loan-principal').last().fill('3000000');
    await page.getByTestId('loan-rate').last().fill('9');

    await expect(page.getByTestId('loan-ready')).toBeVisible();
  });

  test('a zero interest rate counts as declared', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Family loan', '5000');
    await page.getByTestId('loan-principal').last().fill('100000');
    await page.getByTestId('loan-rate').last().fill('0');

    await expect(page.getByTestId('loan-ready')).toBeVisible();
  });

  test('the whole loan survives a reload', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Home loan', '27000');
    await page.getByTestId('loan-principal').last().fill('3000000');
    await page.getByTestId('loan-rate').last().fill('9');
    await page.waitForTimeout(500); // debounced write

    await page.reload();
    await expect(page.getByTestId('loan-name').first()).toHaveValue('Home loan');
    await expect(page.getByTestId('loan-principal').first()).toHaveValue('3000000');
    await expect(page.getByTestId('loan-ready')).toBeVisible();
  });
});

test.describe('Loan · yearly billing', () => {
  test('counts a yearly loan as its twelfth in the budget', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Gold loan', '24000');
    await page.getByTestId('loan-period').last().getByRole('radio', { name: '/yr' }).click();

    // ₹24,000/yr is ₹2,000/mo everywhere the money is counted.
    await expect(page.getByTestId('loan-total-tile')).toContainText('2,000');
    await expect(page.getByTestId('loan-row').last()).toContainText('₹2,000/mo in your budget');
  });

  test('names yearly billing as the thing blocking a forecast', async ({ page }) => {
    await page.goto('/loan');
    await addLoan(page, 'Gold loan', '24000');
    await page.getByTestId('loan-principal').last().fill('200000');
    await page.getByTestId('loan-rate').last().fill('9');
    await page.getByTestId('loan-period').last().getByRole('radio', { name: '/yr' }).click();

    // Everything else is declared, so this is the only gap left.
    await expect(page.getByTestId('loan-row').last()).toContainText('Needs a monthly instalment');
    await expect(page.getByTestId('loan-ready')).toHaveCount(0);
  });
});
