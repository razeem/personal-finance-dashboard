import {
  DEFAULT_FINANCE_INPUTS,
  deriveFinance,
  FinanceInputs,
  icerScore,
  makeLineItem,
  makeMonths,
  sumLineItems,
  sumMonths,
} from './finance.model';

function li(value: number) {
  return { ...makeLineItem('x', value) };
}

describe('sumLineItems', () => {
  it('sums values and ignores non-finite ones', () => {
    expect(sumLineItems([li(10), li(20), li(30)])).toBe(60);
    expect(sumLineItems([])).toBe(0);
  });
});

describe('icerScore', () => {
  it('averages the four axes', () => {
    expect(
      icerScore({ id: 'a', name: 'i', interest: 4, capability: 3, effortlessness: 5, return: 2 }),
    ).toBe(3.5);
  });
});

describe('deriveFinance (monthly inputs, annualised tax)', () => {
  // Gross is monthly: ₹1,00,000/mo → ₹12,00,000/yr, so the annual old-regime tax
  // is still ₹1,63,800 (₹13,650/mo). Spending/savings/etc. are monthly too.
  const inputs: FinanceInputs = {
    ...DEFAULT_FINANCE_INPUTS,
    income: { gross: 100_000, shortTermSavings: 5_000, months: makeMonths(100_000) },
    spending: { needs: [li(20_000), li(5_000)], wants: [li(10_000)] },
    loan: { emis: [li(15_000)] },
    insurance: { premiums: [li(2_000)] },
    investing: { mandatory: [], voluntary: [li(3_000)] },
    tax: { regime: 'old', deductions: DEFAULT_FINANCE_INPUTS.tax.deductions },
  };

  it('annualises gross for the tax computation (fallback: no breakdown)', () => {
    const d = deriveFinance(inputs);
    expect(d.gross).toBe(100_000); // monthly
    expect(d.annualGross).toBe(1_200_000); // × 12
    expect(d.taxAnnual).toBeCloseTo(163_800, 5); // annual old-regime tax
  });

  it('annual gross sums the 12-month breakdown incl. bonuses', () => {
    const months = makeMonths(100_000); // 12 × 100,000 = 1,200,000
    months[11] = { base: 100_000, bonus: 300_000 }; // March bonus
    const d = deriveFinance({ ...inputs, income: { ...inputs.income, months } });
    expect(sumMonths(months)).toBe(1_500_000);
    expect(d.annualGross).toBe(1_500_000); // 1,200,000 + 300,000 bonus
    // Budget still uses the typical monthly base, not the bonus-inflated annual.
    expect(d.gross).toBe(100_000);
  });

  it('rolls loan EMIs into total needs', () => {
    const d = deriveFinance(inputs);
    expect(d.totalLoanEmis).toBe(15_000);
    expect(d.totalNeeds).toBe(40_000); // 25,000 spending + 15,000 EMIs
    expect(d.totalWants).toBe(10_000);
  });

  it('treats loan EMIs as period-aware (yearly ÷ 12)', () => {
    const yearly = { ...makeLineItem('Car', 24_000, 'yearly') }; // ₹2,000/mo
    const d = deriveFinance({ ...inputs, loan: { emis: [yearly] } });
    expect(d.totalLoanEmis).toBe(2_000);
  });

  it('derives the minimum monthly (essential) expense: needs + loan + mandatory', () => {
    const d = deriveFinance({
      ...inputs,
      investing: { mandatory: [makeLineItem('EPF', 3_000)], voluntary: [] },
    });
    // totalNeeds 40,000 (already incl. 15,000 EMIs) + mandatory 3,000
    expect(d.minimumMonthlyExpense).toBe(43_000);
  });

  it('sizes the emergency-fund target by the chosen multiplier', () => {
    const base = {
      ...inputs,
      investing: { mandatory: [makeLineItem('EPF', 3_000)], voluntary: [] },
    };
    // essential expense = 43,000
    const at3 = deriveFinance({ ...base, saving: { emergencyMultiplier: 3 } });
    const at12 = deriveFinance({ ...base, saving: { emergencyMultiplier: 12 } });
    expect(at3.emergencyMultiplier).toBe(3);
    expect(at3.emergencyTarget).toBe(129_000); // 43,000 × 3
    expect(at12.emergencyTarget).toBe(516_000); // 43,000 × 12
  });

  it('buckets money into Living / Safety / Growth & Freedom', () => {
    const d = deriveFinance({
      ...inputs,
      investing: {
        mandatory: [makeLineItem('EPF', 3_000)],
        voluntary: [makeLineItem('MF', 2_000)],
      },
    });
    expect(d.mandatoryInvestments).toBe(3_000);
    expect(d.discretionaryInvestments).toBe(2_000);
    // Living = needs 40k + wants 10k + mandatory EPF 3k
    expect(d.allocation.living).toBe(53_000);
    // Safety = insurance 2k + short-term savings 5k
    expect(d.allocation.safety).toBe(7_000);
    // Growth & Freedom = discretionary MF 2k
    expect(d.allocation.growthFreedom).toBe(2_000);
    expect(d.allocation.total).toBe(62_000);
  });

  // Insurance is usually billed yearly. The monthly budget must therefore see a
  // premium as its twelfth — in BOTH places it lands: minimum income and Safety.
  it('feeds a yearly insurance premium (÷ 12) into minimum income and the Safety bucket', () => {
    const monthly = deriveFinance({
      ...inputs,
      insurance: { premiums: [makeLineItem('Term', 2_000)] }, // ₹2,000/mo
    });
    const yearly = deriveFinance({
      ...inputs,
      insurance: { premiums: [makeLineItem('Term', 24_000, 'yearly')] }, // same ₹2,000/mo
    });

    expect(yearly.totalInsurance).toBe(2_000);
    expect(yearly.totalInsurance).toBe(monthly.totalInsurance);
    // Safety = insurance + short-term savings (5,000).
    expect(yearly.allocation.safety).toBe(7_000);
    expect(yearly.minimumIncome).toBeCloseTo(monthly.minimumIncome, 5);
  });

  it('raises minimum income and Safety by exactly the premium added', () => {
    const without = deriveFinance({ ...inputs, insurance: { premiums: [] } });
    const withYearly = deriveFinance({
      ...inputs,
      insurance: { premiums: [makeLineItem('Health', 36_000, 'yearly')] }, // ₹3,000/mo
    });

    expect(withYearly.minimumIncome - without.minimumIncome).toBeCloseTo(3_000, 5);
    expect(withYearly.allocation.safety - without.allocation.safety).toBeCloseTo(3_000, 5);
    expect(withYearly.allocation.total - without.allocation.total).toBeCloseTo(3_000, 5);
  });

  it('derives MONTHLY tax, net income, minimum income and surplus (old regime)', () => {
    const d = deriveFinance(inputs);
    expect(d.taxPayable).toBeCloseTo(13_650, 5); // 163,800 / 12
    expect(d.netIncome).toBeCloseTo(86_350, 5); // 100,000 − 13,650
    // 40,000 + 10,000 + 5,000 + 2,000 + 3,000 − 13,650
    expect(d.minimumIncome).toBeCloseTo(46_350, 5);
    // surplus = monthly gross − monthly outgoings = 100,000 − 60,000
    expect(d.surplus).toBeCloseTo(40_000, 5);
  });

  it('reacts to the selected tax regime', () => {
    const asOld = deriveFinance({ ...inputs, tax: { ...inputs.tax, regime: 'old' } });
    const asNew = deriveFinance({ ...inputs, tax: { ...inputs.tax, regime: 'new' } });
    // FY 2025-26: ₹12L annual gross under the new regime is fully rebated (₹0 tax);
    // the old regime still taxes it — the two regimes must differ.
    expect(asOld.taxPayable).toBeCloseTo(13_650, 5);
    expect(asNew.taxPayable).toBe(0);
  });
});

describe('sumLineItems — edge cases', () => {
  it('ignores NaN and Infinity but keeps negatives', () => {
    expect(sumLineItems([li(NaN), li(10), li(Infinity)])).toBe(10);
    expect(sumLineItems([li(-5), li(10)])).toBe(5);
  });
});

describe('icerScore — edge cases', () => {
  it('returns the min and max cleanly', () => {
    expect(
      icerScore({ id: 'a', name: '', interest: 1, capability: 1, effortlessness: 1, return: 1 }),
    ).toBe(1);
    expect(
      icerScore({ id: 'b', name: '', interest: 5, capability: 5, effortlessness: 5, return: 5 }),
    ).toBe(5);
  });
});

describe('deriveFinance — edge cases', () => {
  const empty: FinanceInputs = {
    income: { gross: 0, shortTermSavings: 0, months: [] },
    goals: { mustHave: [], goodToHave: [] },
    ideas: [],
    spending: { needs: [], wants: [] },
    loan: { emis: [] },
    saving: { emergencyMultiplier: 6 },
    insurance: { premiums: [] },
    investing: { mandatory: [], voluntary: [] },
    tax: { regime: 'old', deductions: DEFAULT_FINANCE_INPUTS.tax.deductions },
    allocationTarget: { living: 75, safety: 15, growth: 10 },
  };

  it('produces all zeros for an empty model', () => {
    const d = deriveFinance(empty);
    expect(d.gross).toBe(0);
    expect(d.taxPayable).toBe(0);
    expect(d.totalNeeds).toBe(0);
    expect(d.minimumIncome).toBe(0);
    expect(d.surplus).toBe(0);
  });

  it('reports a deficit (negative surplus) when spending exceeds income', () => {
    const d = deriveFinance({
      ...empty,
      income: { gross: 30_000, shortTermSavings: 0, months: [] },
      spending: { needs: [li(50_000)], wants: [] },
      tax: { regime: 'new', deductions: empty.tax.deductions },
    });
    // surplus = gross − (needs+wants+savings+insurance+investments) = 30,000 − 50,000
    expect(d.surplus).toBeCloseTo(-20_000, 5);
  });

  it('new-regime 87A rebate keeps tax at zero for modest income', () => {
    const d = deriveFinance({
      ...empty,
      income: { gross: 50_000, shortTermSavings: 0, months: [] }, // ₹6,00,000/yr — within the rebate
      tax: { regime: 'new', deductions: empty.tax.deductions },
    });
    expect(d.taxPayable).toBe(0);
    expect(d.netIncome).toBe(50_000); // monthly, no tax
  });
});
