import {
  buildBarChart,
  buildLineChart,
  ChartOptions,
  DEFAULT_PADDING,
  niceCeil,
  Series,
  SERIES_COLORS,
  seriesColor,
  valueDomain,
} from './spark-chart.model';

// A 100×60 viewBox with no padding makes the arithmetic checkable by hand:
// the plot area is exactly (0,0)–(100,60), so x and y are readable as fractions.
const PLAIN: ChartOptions = {
  width: 100,
  height: 60,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};

describe('niceCeil', () => {
  it('rounds up to 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.4)).toBe(2);
    expect(niceCeil(2.4)).toBe(2.5);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(57_431)).toBe(100_000);
    expect(niceCeil(23_000)).toBe(25_000);
  });

  it('is a no-op for zero and nonsense', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-5)).toBe(0);
    expect(niceCeil(NaN)).toBe(0);
  });
});

describe('valueDomain', () => {
  it('always includes zero so small wobbles are not exaggerated', () => {
    const { min, max } = valueDomain([[40_000, 41_000, 42_000]]);
    expect(min).toBe(0);
    expect(max).toBe(50_000);
  });

  it('extends below zero only when the data does', () => {
    const { min, max } = valueDomain([[-3_000, 8_000]]);
    expect(min).toBe(-5_000);
    expect(max).toBe(10_000);
  });

  it('uses column totals when stacked, not individual values', () => {
    const grouped = valueDomain([
      [3, 3],
      [4, 4],
    ]);
    const stacked = valueDomain(
      [
        [3, 3],
        [4, 4],
      ],
      true,
    );
    expect(grouped.max).toBe(5); // tallest single bar is 4 → nice 5
    expect(stacked.max).toBe(10); // tallest column is 7 → nice 10
  });

  it('gives an all-zero chart a non-zero span to divide by', () => {
    const { min, max } = valueDomain([[0, 0, 0]]);
    expect(max).toBeGreaterThan(min);
  });

  it('ignores non-finite values', () => {
    expect(valueDomain([[NaN, Infinity, 5]]).max).toBe(5);
  });
});

describe('seriesColor', () => {
  it('starts at the app gradient stops so two series read as the brand', () => {
    expect(seriesColor({ label: 'a', values: [] }, 0)).toBe('#6366f1'); // --accent-1
    expect(seriesColor({ label: 'b', values: [] }, 1)).toBe('#22d3ee'); // --accent-2
  });

  it('wraps round the palette rather than running out', () => {
    expect(seriesColor({ label: 'x', values: [] }, SERIES_COLORS.length)).toBe(SERIES_COLORS[0]);
  });

  it('lets a series override its colour', () => {
    expect(seriesColor({ label: 'x', values: [], color: '#abcdef' }, 0)).toBe('#abcdef');
  });
});

describe('buildLineChart', () => {
  const series: Series[] = [{ label: 'Income', values: [0, 50, 100] }];

  it('spreads points edge to edge across the plot area', () => {
    const chart = buildLineChart(series, PLAIN);
    expect(chart.series[0].points.map((p) => p.x)).toEqual([0, 50, 100]);
  });

  it('maps values top-down: the maximum sits at the top edge', () => {
    const chart = buildLineChart(series, PLAIN);
    const [zero, mid, top] = chart.series[0].points;
    expect(zero.y).toBe(60); // value 0 → the bottom
    expect(mid.y).toBe(30); // value 50 of a 0–100 domain → halfway
    expect(top.y).toBe(0); // value 100 → the top
  });

  it('emits a path that starts with a move and continues with lines', () => {
    const chart = buildLineChart(series, PLAIN);
    expect(chart.series[0].path).toBe('M0,60 L50,30 L100,0');
  });

  it('closes the area back along the baseline', () => {
    const chart = buildLineChart(series, PLAIN);
    expect(chart.series[0].area).toBe('M0,60 L50,30 L100,0 L100,60 L0,60 Z');
  });

  it('centres a single point instead of pinning it to the left edge', () => {
    const chart = buildLineChart([{ label: 'one', values: [10] }], PLAIN);
    expect(chart.series[0].points[0].x).toBe(50);
  });

  it('produces no path at all for an empty series', () => {
    const chart = buildLineChart([{ label: 'none', values: [] }], PLAIN);
    expect(chart.series[0].path).toBe('');
    expect(chart.series[0].area).toBe('');
  });

  it('gives every series its own colour and keeps the labels', () => {
    const chart = buildLineChart(
      [
        { label: 'Income', values: [1] },
        { label: 'Expenses', values: [1] },
      ],
      PLAIN,
    );
    expect(chart.series.map((s) => s.label)).toEqual(['Income', 'Expenses']);
    expect(chart.series[0].color).not.toBe(chart.series[1].color);
  });

  it('draws gridlines at round values inside the domain', () => {
    const chart = buildLineChart([{ label: 'x', values: [0, 57_431] }], PLAIN);
    expect(chart.yTicks.map((t) => t.value)).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
    expect(chart.yTicks[0].offset).toBe(60); // zero at the bottom
    expect(chart.yTicks[4].offset).toBe(0); // max at the top
  });

  it('respects padding — the plot area is inset from the viewBox', () => {
    const chart = buildLineChart(series, { width: 100, height: 60, padding: DEFAULT_PADDING });
    expect(chart.left).toBe(DEFAULT_PADDING.left);
    expect(chart.right).toBe(100 - DEFAULT_PADDING.right);
    expect(chart.top).toBe(DEFAULT_PADDING.top);
    expect(chart.bottom).toBe(60 - DEFAULT_PADDING.bottom);
  });

  it('treats non-finite values as zero rather than emitting NaN into the path', () => {
    const chart = buildLineChart([{ label: 'x', values: [NaN, 100] }], PLAIN);
    expect(chart.series[0].path).not.toContain('NaN');
  });
});

describe('buildBarChart', () => {
  it('sits bars inside evenly divided bands, not on the edges', () => {
    const chart = buildBarChart([{ label: 'a', values: [10, 10] }], PLAIN);
    // Two columns across 100 units → bands centred at 25 and 75.
    expect(chart.xTicks.map((t) => t.offset)).toEqual([25, 75]);
  });

  it('grows bars up from the baseline', () => {
    const chart = buildBarChart([{ label: 'a', values: [50, 100] }], PLAIN);
    const [first, second] = chart.bars;
    expect(chart.baseline).toBe(60);
    expect(first.y).toBe(30);
    expect(first.height).toBe(30);
    expect(second.y).toBe(0);
    expect(second.height).toBe(60);
  });

  it('places grouped series side by side within a column', () => {
    const chart = buildBarChart(
      [
        { label: 'a', values: [10] },
        { label: 'b', values: [10] },
      ],
      PLAIN,
    );
    const [a, b] = chart.bars;
    expect(a.width).toBeCloseTo(b.width, 6);
    expect(b.x).toBeCloseTo(a.x + a.width, 6);
  });

  it('stacks series on top of each other, filling the column', () => {
    const chart = buildBarChart(
      [
        { label: 'a', values: [30] },
        { label: 'b', values: [70] },
      ],
      PLAIN,
      true,
    );
    const [a, b] = chart.bars;
    // Domain max is 100, so the two together fill the full 60-unit height.
    expect(a.height + b.height).toBeCloseTo(60, 6);
    // b starts exactly where a's top is.
    expect(b.y + b.height).toBeCloseTo(a.y, 6);
    expect(a.width).toBe(b.width); // stacked segments share one width
  });

  it('keeps stacked segments in series order from the baseline up', () => {
    const chart = buildBarChart(
      [
        { label: 'first', values: [50] },
        { label: 'second', values: [50] },
      ],
      PLAIN,
      true,
    );
    const [first, second] = chart.bars;
    expect(first.y).toBeGreaterThan(second.y); // first is lower down = nearer the baseline
  });

  it('ignores negatives when stacking rather than punching through the column', () => {
    const chart = buildBarChart(
      [
        { label: 'a', values: [100] },
        { label: 'b', values: [-40] },
      ],
      PLAIN,
      true,
    );
    const [a, b] = chart.bars;
    expect(b.height).toBe(0);
    expect(a.height).toBeCloseTo(60, 6);
  });

  it('draws a negative grouped bar downward from zero', () => {
    const chart = buildBarChart([{ label: 'a', values: [-50, 50] }], PLAIN);
    const [negative] = chart.bars;
    // Domain is −50…50, so zero is halfway down and the bar hangs below it.
    expect(chart.baseline).toBe(30);
    expect(negative.y).toBe(30);
    expect(negative.height).toBe(30);
  });

  it('carries the value and label through for tooltips', () => {
    const chart = buildBarChart([{ label: 'Needs', values: [1_234] }], PLAIN);
    expect(chart.bars[0].label).toBe('Needs');
    expect(chart.bars[0].value).toBe(1_234);
    expect(chart.bars[0].index).toBe(0);
  });

  it('produces nothing for an empty series', () => {
    expect(buildBarChart([{ label: 'none', values: [] }], PLAIN).bars).toEqual([]);
  });
});
