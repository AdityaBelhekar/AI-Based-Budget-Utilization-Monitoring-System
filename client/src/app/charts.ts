import { Component, computed, input } from '@angular/core';
import { crore, monthShort } from './format';

const W = 560;
const H = 220;
const PAD = { left: 56, right: 12, top: 12, bottom: 28 };

function ticks(max: number) {
  if (max <= 0) return [0];
  const step = 10 ** Math.floor(Math.log10(max / 3));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= 4) ?? step * 10;
  return Array.from({ length: Math.floor(max / nice) + 1 }, (_, i) => i * nice);
}

/** Cumulative spending against an even pace through the year. The gap is shaded only when it is off pace. */
@Component({
  selector: 'app-trend',
  template: `
    <svg class="chart" [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="label()">
      @for (t of yTicks(); track t) {
        <line [attr.x1]="PAD.left" [attr.x2]="W - PAD.right" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--rule)" />
        <text [attr.x]="PAD.left - 8" [attr.y]="y(t) + 4" text-anchor="end">{{ crore(t) }}</text>
      }
      @for (m of allMonths(); track m; let i = $index) {
        <text [attr.x]="x(i)" [attr.y]="H - 8" text-anchor="middle">{{ monthShort(m) }}</text>
      }
      @if (gapArea()) {
        <polygon [attr.points]="gapArea()" [attr.fill]="status() === 'behind' ? 'var(--behind)' : 'var(--ahead)'" fill-opacity="0.16" />
      }
      <polyline [attr.points]="line('pacePaise')" fill="none" stroke="var(--secondary)" stroke-width="1.5" stroke-dasharray="4 4" />
      <polyline [attr.points]="line('cumulativePaise')" fill="none" stroke="var(--ink)" stroke-width="2" />
      @if (labels(); as l) {
        <text [attr.x]="l.x" [attr.y]="l.spent" class="ink">Spent</text>
        <text [attr.x]="l.x" [attr.y]="l.pace">Even pace</text>
      }
    </svg>
    <p class="small muted">Rs crore, cumulative. The dashed line is what even spending through the year would reach.</p>
  `,
})
export class TrendChart {
  points = input.required<{ month: string; cumulativePaise: number; pacePaise: number; allocatedPaise: number }[]>();
  allMonths = input.required<string[]>();
  status = input<string>('on');
  protected W = W;
  protected H = H;
  protected PAD = PAD;
  protected crore = (paise: number) => crore(paise);
  protected monthShort = monthShort;

  private max = computed(() => Math.max(1, ...this.points().flatMap((p) => [p.cumulativePaise, p.pacePaise])));
  protected yTicks = computed(() => ticks(this.max()));
  private top = computed(() => Math.max(this.max(), this.yTicks().at(-1) ?? 0));
  protected x = (i: number) => PAD.left + ((W - PAD.left - PAD.right - 60) * i) / 11;
  protected y = (v: number) => H - PAD.bottom - ((H - PAD.top - PAD.bottom) * Math.max(v, 0)) / this.top();
  protected line = (key: 'cumulativePaise' | 'pacePaise') => this.points().map((p, i) => `${this.x(i)},${this.y(p[key])}`).join(' ');
  protected labels = computed(() => {
    const last = this.points().at(-1);
    if (!last) return null;
    let spent = this.y(last.cumulativePaise) + 4;
    let pace = this.y(last.pacePaise) + 4;
    if (Math.abs(spent - pace) < 15) {
      const mid = (spent + pace) / 2;
      [spent, pace] = last.cumulativePaise >= last.pacePaise ? [mid - 8, mid + 8] : [mid + 8, mid - 8];
    }
    return { x: this.x(this.points().length - 1) + 6, spent, pace };
  });
  protected gapArea = computed(() => {
    if (!['behind', 'ahead'].includes(this.status()) || this.points().length < 2) return '';
    const top = this.points().map((p, i) => `${this.x(i)},${this.y(p.cumulativePaise)}`);
    const bottom = this.points().map((p, i) => `${this.x(i)},${this.y(p.pacePaise)}`).reverse();
    return [...top, ...bottom].join(' ');
  });
  protected label = computed(() => {
    const last = this.points().at(-1);
    return last ? `Cumulative spending of Rs ${crore(last.cumulativePaise)} crore against an even pace of Rs ${crore(last.pacePaise)} crore by ${monthShort(last.month)}.` : 'No spending yet.';
  });
}

/** Spending by month; months the spike check flagged are marked and named. */
@Component({
  selector: 'app-monthly-bars',
  template: `
    <svg class="chart" [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="label()">
      @for (t of yTicks(); track t) {
        <line [attr.x1]="PAD.left" [attr.x2]="W - PAD.right" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--rule)" />
        <text [attr.x]="PAD.left - 8" [attr.y]="y(t) + 4" text-anchor="end">{{ crore(t) }}</text>
      }
      @for (m of allMonths(); track m; let i = $index) {
        <text [attr.x]="x(i) + bw / 2" [attr.y]="H - 8" text-anchor="middle">{{ monthShort(m) }}</text>
      }
      @for (b of bars(); track b.month; let i = $index) {
        <rect [attr.x]="x(i)" [attr.width]="bw" [attr.y]="Math.min(y(b.amountPaise), y(0))" [attr.height]="Math.abs(y(0) - y(b.amountPaise))" [attr.fill]="b.spike ? 'var(--ahead)' : 'var(--spent)'" rx="2" />
        @if (b.spike) {
          <text [attr.x]="x(i) + bw / 2" [attr.y]="y(b.amountPaise) - 6" text-anchor="middle" class="ink">Spike</text>
        }
      }
    </svg>
    <p class="small muted">Rs crore spent each month. Orange marks a month the spike check flagged.</p>
  `,
})
export class MonthlyBars {
  bars = input.required<{ month: string; amountPaise: number; spike: string | null }[]>();
  allMonths = input.required<string[]>();
  protected W = W;
  protected H = H;
  protected PAD = PAD;
  protected Math = Math;
  protected bw = (W - PAD.left - PAD.right) / 12 - 8;
  protected crore = (paise: number) => crore(paise);
  protected monthShort = monthShort;
  private max = computed(() => Math.max(1, ...this.bars().map((b) => b.amountPaise)) * 1.12);
  private min = computed(() => Math.min(0, ...this.bars().map((b) => b.amountPaise)));
  protected yTicks = computed(() => ticks(this.max()));
  private top = computed(() => Math.max(this.max(), this.yTicks().at(-1) ?? 0));
  protected x = (i: number) => PAD.left + 4 + ((W - PAD.left - PAD.right) * i) / 12;
  protected y = (v: number) => PAD.top + ((H - PAD.top - PAD.bottom) * (this.top() - v)) / (this.top() - this.min());
  protected label = computed(() => {
    const spikes = this.bars().filter((b) => b.spike).map((b) => monthShort(b.month));
    return `Monthly spending for ${this.bars().length} months.${spikes.length ? ` Spikes flagged in ${spikes.join(', ')}.` : ' No spikes flagged.'}`;
  });
}

/**
 * Where the rupee went, as the Union Budget presents it: in paise per rupee. Greyscale on purpose,
 * because colour in this interface only ever means money off pace.
 */
@Component({
  selector: 'app-rupee-pie',
  template: `
    <div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: center">
      <svg class="chart" viewBox="-110 -110 220 220" style="width: 180px" role="img" [attr.aria-label]="label()">
        @for (s of slices(); track s.category) {
          <path [attr.d]="s.path" fill="var(--ink)" [attr.fill-opacity]="s.shade" stroke="var(--surface)" stroke-width="2" />
        }
      </svg>
      <ul class="legend" style="flex: 1; min-width: 180px">
        @for (s of slices(); track s.category) {
          <li>
            <span><span class="swatch" style="background: var(--ink)" [style.opacity]="s.shade"></span>{{ s.category }}</span>
            <span class="strong">{{ s.paise }} paise</span>
          </li>
        }
      </ul>
    </div>
  `,
})
export class RupeePie {
  data = input.required<{ category: string; amountPaise: number }[]>();
  private shades = [1, 0.72, 0.5, 0.32, 0.18];

  protected slices = computed(() => {
    const total = this.data().reduce((s, d) => s + d.amountPaise, 0) || 1;
    // Largest remainder, so the paise always add up to exactly one rupee.
    const raw = this.data().map((d) => (d.amountPaise / total) * 100);
    const paise = raw.map(Math.floor);
    raw
      .map((r, i) => ({ i, rem: r - Math.floor(r) }))
      .sort((a, b) => b.rem - a.rem)
      .slice(0, 100 - paise.reduce((a, b) => a + b, 0))
      .forEach(({ i }) => paise[i]++);
    let angle = -Math.PI / 2;
    return this.data().map((d, i) => {
      const sweep = (d.amountPaise / total) * Math.PI * 2;
      const [x1, y1] = [Math.cos(angle) * 100, Math.sin(angle) * 100];
      angle += sweep;
      const [x2, y2] = [Math.cos(angle) * 100, Math.sin(angle) * 100];
      const path = sweep >= Math.PI * 2 - 1e-9 ? 'M0,-100A100,100 0 1,1 -0.01,-100Z' : `M0,0L${x1},${y1}A100,100 0 ${sweep > Math.PI ? 1 : 0},1 ${x2},${y2}Z`;
      return { category: d.category, paise: paise[i], shade: this.shades[i] ?? 0.18, path };
    });
  });

  protected label = computed(() => `Of every rupee spent: ${this.slices().map((s) => `${s.category} ${s.paise} paise`).join(', ')}.`);
}
