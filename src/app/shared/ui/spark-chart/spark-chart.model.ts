/**
 * Pure geometry for `spark-chart` — no Angular, no dependencies, no DOM.
 *
 * The component is deliberately thin: everything that decides where a pixel goes
 * lives here as a function from data to plain numbers, so the scales, the nice
 * axis rounding and the stacking are all unit-testable without rendering
 * anything. Coordinates are in **viewBox units**, not CSS pixels — the SVG is
 * scaled to its container, so the chart is resolution- and size-independent.
 */

export interface Series {
  label: string;
  values: number[];
  /** Overrides the palette entry for this series. */
  color?: string;
}

export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartOptions {
  width: number;
  height: number;
  padding: ChartPadding;
  /** Roughly how many horizontal gridlines to draw. Default 4. */
  tickCount?: number;
}

export const DEFAULT_PADDING: ChartPadding = { top: 12, right: 10, bottom: 26, left: 58 };

/**
 * Series colours. The first two are the app's own gradient stops (`--accent-1`
 * indigo → `--accent-2` cyan), so a two-series chart — income vs expenses, the
 * common case — reads as the brand gradient. The rest keep going round the wheel
 * at similar lightness so no single category shouts louder than another.
 */
export const SERIES_COLORS = [
  '#6366f1', // indigo — --accent-1
  '#22d3ee', // cyan — --accent-2
  '#a855f7', // purple
  '#f5b544', // amber
  '#34d399', // emerald
  '#f472b6', // pink
  '#94a3b8', // slate — deliberately neutral, and the only hue far enough from
  //            the cyan above to stay distinguishable in a seven-way stack
] as const;

export function seriesColor(series: Series, index: number): string {
  return series.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
}

export interface Tick {
  value: number;
  /** Position along the axis, in viewBox units. */
  offset: number;
}

export interface Point {
  index: number;
  value: number;
  x: number;
  y: number;
}

export interface LineSeriesGeometry {
  label: string;
  color: string;
  /** `d` for the line itself. Empty when the series has no values. */
  path: string;
  /** `d` for the filled area under the line, closed along the baseline. */
  area: string;
  points: Point[];
}

export interface Bar {
  seriesIndex: number;
  label: string;
  color: string;
  index: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartFrame {
  /** Plot-area bounds in viewBox units. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Y of the value-zero line — where bars sit and areas close. */
  baseline: number;
  min: number;
  max: number;
  yTicks: Tick[];
  /** One entry per category/column, at its centre. */
  xTicks: Tick[];
}

export interface LineChart extends ChartFrame {
  kind: 'line';
  series: LineSeriesGeometry[];
}

export interface BarChart extends ChartFrame {
  kind: 'bar';
  bars: Bar[];
}

// --- Scales -----------------------------------------------------------------

/**
 * Round a value up to a readable axis maximum: 1, 2, 2.5, 5 or 10 times a power
 * of ten. Keeps gridline labels as round numbers (₹1,00,000 rather than
 * ₹57,431). The 10× rung matters — without it anything above 5× the magnitude
 * would round *down* and the tallest bar would overflow the plot area.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * The value range a chart should cover. Always includes zero — a spending chart
 * that starts at ₹40,000 exaggerates every wobble into a cliff.
 */
export function valueDomain(
  seriesValues: readonly (readonly number[])[],
  stacked = false,
): { min: number; max: number } {
  const flat = stacked ? stackedTotals(seriesValues) : seriesValues.flat();
  const finite = flat.filter((v) => Number.isFinite(v));
  const rawMax = Math.max(0, ...finite);
  const rawMin = Math.min(0, ...finite);
  const max = niceCeil(rawMax);
  const min = rawMin < 0 ? -niceCeil(-rawMin) : 0;
  // A chart of nothing but zeroes still needs a non-zero span to divide by.
  return max === min ? { min, max: min + 1 } : { min, max };
}

/** Column totals when series are stacked on top of each other. */
function stackedTotals(seriesValues: readonly (readonly number[])[]): number[] {
  const length = Math.max(0, ...seriesValues.map((v) => v.length));
  return Array.from({ length }, (_, i) =>
    seriesValues.reduce((sum, values) => sum + Math.max(0, values[i] ?? 0), 0),
  );
}

function frame(
  columns: number,
  domain: { min: number; max: number },
  options: ChartOptions,
): ChartFrame {
  const { width, height, padding } = options;
  const left = padding.left;
  const right = width - padding.right;
  const top = padding.top;
  const bottom = height - padding.bottom;
  const span = domain.max - domain.min;

  const y = (value: number) => bottom - ((value - domain.min) / span) * (bottom - top);
  const tickCount = Math.max(1, options.tickCount ?? 4);
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = domain.min + (span * i) / tickCount;
    return { value, offset: y(value) };
  });

  const xTicks = Array.from({ length: columns }, (_, i) => ({
    value: i,
    offset: columnCentre(i, columns, left, right),
  }));

  return {
    left,
    right,
    top,
    bottom,
    baseline: y(0),
    min: domain.min,
    max: domain.max,
    yTicks,
    xTicks,
  };
}

/**
 * Centre of column `i`. Lines put their first and last point flush against the
 * edges; bars sit inside evenly-divided bands. `bandCentred` picks which.
 */
function columnCentre(
  i: number,
  columns: number,
  left: number,
  right: number,
  bandCentred = false,
): number {
  if (columns <= 0) return left;
  if (bandCentred || columns === 1) {
    const band = (right - left) / columns;
    return left + band * (i + 0.5);
  }
  return left + ((right - left) * i) / (columns - 1);
}

// --- Builders ---------------------------------------------------------------

/** Line (or area) chart geometry: one path per series, plus a point per value. */
export function buildLineChart(series: readonly Series[], options: ChartOptions): LineChart {
  const columns = Math.max(0, ...series.map((s) => s.values.length));
  const domain = valueDomain(series.map((s) => s.values));
  const base = frame(columns, domain, options);
  const span = domain.max - domain.min;
  const y = (value: number) =>
    base.bottom - ((value - domain.min) / span) * (base.bottom - base.top);

  const geometry = series.map((s, seriesIndex): LineSeriesGeometry => {
    const points = s.values.map((value, index): Point => ({
      index,
      value,
      x: columnCentre(index, columns, base.left, base.right),
      y: y(Number.isFinite(value) ? value : 0),
    }));
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`)
      .join(' ');
    const area = points.length
      ? `${path} L${round(points[points.length - 1].x)},${round(base.baseline)} ` +
        `L${round(points[0].x)},${round(base.baseline)} Z`
      : '';
    return { label: s.label, color: seriesColor(s, seriesIndex), path, area, points };
  });

  return { kind: 'line', ...base, series: geometry };
}

/**
 * Bar chart geometry. Grouped by default — series sit side by side within each
 * column; `stacked` piles them instead, which is what an expense breakdown
 * wants. Stacking treats values as magnitudes above the baseline, so a negative
 * contributes nothing rather than punching a hole through the column.
 */
export function buildBarChart(
  series: readonly Series[],
  options: ChartOptions,
  stacked = false,
): BarChart {
  const columns = Math.max(0, ...series.map((s) => s.values.length));
  const domain = valueDomain(
    series.map((s) => s.values),
    stacked,
  );
  const base = frame(columns, domain, options);
  const span = domain.max - domain.min;
  const y = (value: number) =>
    base.bottom - ((value - domain.min) / span) * (base.bottom - base.top);

  const band = columns > 0 ? (base.right - base.left) / columns : 0;
  const groupWidth = band * 0.72; // 28% breathing room between columns
  const barWidth = stacked ? groupWidth : groupWidth / Math.max(1, series.length);

  const bars: Bar[] = [];
  // Running height per column, so each stacked segment starts where the last ended.
  const stackTops = new Array<number>(columns).fill(0);

  series.forEach((s, seriesIndex) => {
    const color = seriesColor(s, seriesIndex);
    s.values.forEach((raw, index) => {
      const value = Number.isFinite(raw) ? raw : 0;
      const centre = base.left + band * (index + 0.5);
      const x = stacked
        ? centre - groupWidth / 2
        : centre - groupWidth / 2 + barWidth * seriesIndex;

      if (stacked) {
        const magnitude = Math.max(0, value);
        const from = stackTops[index];
        const to = from + magnitude;
        stackTops[index] = to;
        bars.push({
          seriesIndex,
          label: s.label,
          color,
          index,
          value,
          x,
          y: y(to),
          width: barWidth,
          height: Math.abs(y(from) - y(to)),
        });
      } else {
        const top = Math.max(value, 0);
        const bottomOfBar = Math.min(value, 0);
        bars.push({
          seriesIndex,
          label: s.label,
          color,
          index,
          value,
          x,
          y: y(top),
          width: barWidth,
          height: Math.abs(y(bottomOfBar) - y(top)),
        });
      }
    });
  });

  const xTicks = Array.from({ length: columns }, (_, i) => ({
    value: i,
    offset: columnCentre(i, columns, base.left, base.right, true),
  }));

  return { kind: 'bar', ...base, xTicks, bars };
}

/** Trim float noise out of path data — SVG does not need 15 decimal places. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
