import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  buildBarChart,
  buildLineChart,
  ChartOptions,
  DEFAULT_PADDING,
  Series,
  seriesColor,
} from './spark-chart.model';

/**
 * A small, dependency-free SVG chart.
 *
 * No charting library — the geometry is pure maths in `spark-chart.model.ts` and
 * this component only turns it into elements, the same way the EMI donut is hand
 * drawn. It scales to its container via `viewBox` rather than measuring the DOM,
 * so it renders identically during the build-time prerender and after hydration.
 *
 * Colours come from the app's own gradient stops, and every value carries a
 * native `<title>` so hovering a point or a bar reads out the figure without any
 * tooltip machinery.
 */
@Component({
  selector: 'app-spark-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="m-0 flex flex-col gap-2" [attr.data-testid]="testid()">
      <!--
        The viewBox is sized in near-pixel units and the SVG scales uniformly to
        its container (h-auto), so text and dots keep their proportions at any
        width. preserveAspectRatio="none" would stretch them sideways instead.
      -->
      <svg
        [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
        class="block h-auto w-full overflow-visible"
        role="img"
        [attr.aria-label]="ariaLabel()"
      >
        <!-- Gridlines + value axis -->
        @for (tick of frame().yTicks; track tick.value) {
          <line
            [attr.x1]="frame().left"
            [attr.x2]="frame().right"
            [attr.y1]="tick.offset"
            [attr.y2]="tick.offset"
            stroke="var(--mat-sys-outline-variant)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <text
            [attr.x]="frame().left - 8"
            [attr.y]="tick.offset + 4"
            text-anchor="end"
            fill="var(--mat-sys-on-surface-variant)"
            style="font-size: 11px"
          >
            {{ tickLabel(tick.value) }}
          </text>
        }

        @if (lineChart(); as chart) {
          @for (s of chart.series; track s.label) {
            @if (fill()) {
              <path [attr.d]="s.area" [attr.fill]="s.color" opacity="0.12" />
            }
            <path
              [attr.d]="s.path"
              fill="none"
              [attr.stroke]="s.color"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
            @for (point of s.points; track point.index) {
              <circle
                [attr.cx]="point.x"
                [attr.cy]="point.y"
                r="3"
                [attr.fill]="s.color"
                [attr.data-testid]="testid() + '-point-' + s.label + '-' + point.index"
              >
                <title>{{ s.label }} · {{ labelAt(point.index) }}: {{ point.value }}</title>
              </circle>
            }
          }
        }

        @if (barChart(); as chart) {
          @for (bar of chart.bars; track bar.seriesIndex + ':' + bar.index) {
            <rect
              [attr.x]="bar.x"
              [attr.y]="bar.y"
              [attr.width]="bar.width"
              [attr.height]="bar.height"
              [attr.fill]="bar.color"
              [attr.data-testid]="testid() + '-bar-' + bar.label + '-' + bar.index"
            >
              <title>{{ bar.label }} · {{ labelAt(bar.index) }}: {{ bar.value }}</title>
            </rect>
          }
        }

        <!-- Baseline sits above the data so a zero column is still visible -->
        <line
          [attr.x1]="frame().left"
          [attr.x2]="frame().right"
          [attr.y1]="frame().baseline"
          [attr.y2]="frame().baseline"
          stroke="var(--mat-sys-outline)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />

        <!-- Category axis: thinned out so labels never collide -->
        @for (tick of frame().xTicks; track tick.value) {
          @if (showsXLabel(tick.value)) {
            <text
              [attr.x]="tick.offset"
              [attr.y]="height() - 8"
              text-anchor="middle"
              fill="var(--mat-sys-on-surface-variant)"
              style="font-size: 11px"
            >
              {{ labelAt(tick.value) }}
            </text>
          }
        }
      </svg>

      <figcaption class="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem]">
        @for (s of series(); track s.label; let i = $index) {
          <span class="inline-flex items-center gap-1.5">
            <span
              class="inline-block h-2.5 w-2.5 rounded-full"
              [style.background]="color(s, i)"
            ></span>
            {{ s.label }}
          </span>
        }
      </figcaption>
    </figure>
  `,
})
export class SparkChart {
  readonly series = input.required<readonly Series[]>();
  readonly kind = input<'line' | 'bar'>('line');
  readonly stacked = input<boolean>(false);
  /** One label per column — month names, FY names, whatever the data indexes by. */
  readonly labels = input<readonly string[]>([]);
  /** Shade the area under a line. Ignored for bars. */
  readonly fill = input<boolean>(true);
  readonly testid = input<string>('spark-chart');
  /** Formats the value-axis labels — pass a compact currency formatter. */
  readonly formatTick = input<(value: number) => string>((value) => String(Math.round(value)));

  // viewBox units are chosen to land near CSS pixels at a typical card width, so
  // the 11px axis labels read at roughly 11px on screen. The height follows from
  // this ratio (the SVG is `h-auto`), giving a consistent ~3:1 chart everywhere.
  protected readonly width = computed(() => 640);
  protected readonly height = computed(() => 210);

  private readonly options = computed<ChartOptions>(() => ({
    width: this.width(),
    height: this.height(),
    padding: DEFAULT_PADDING,
  }));

  protected readonly lineChart = computed(() =>
    this.kind() === 'line' ? buildLineChart(this.series(), this.options()) : null,
  );
  protected readonly barChart = computed(() =>
    this.kind() === 'bar' ? buildBarChart(this.series(), this.options(), this.stacked()) : null,
  );
  protected readonly frame = computed(() => this.lineChart() ?? this.barChart()!);

  protected readonly ariaLabel = computed(() => {
    const names = this.series().map((s) => s.label);
    const columns = this.labels().length;
    return `${this.kind() === 'bar' ? 'Bar' : 'Line'} chart of ${names.join(', ')} across ${columns} periods`;
  });

  protected color(series: Series, index: number): string {
    return seriesColor(series, index);
  }

  protected tickLabel(value: number): string {
    return this.formatTick()(value);
  }

  protected labelAt(index: number): string {
    return this.labels()[index] ?? String(index + 1);
  }

  /**
   * Show at most ~6 category labels, evenly spaced, always including the last —
   * twelve month names across a phone-width axis would overlap into mush.
   */
  protected showsXLabel(index: number): boolean {
    const total = this.frame().xTicks.length;
    if (total <= 6) return true;
    const stride = Math.ceil(total / 6);
    return index === total - 1 || index % stride === 0;
  }
}
