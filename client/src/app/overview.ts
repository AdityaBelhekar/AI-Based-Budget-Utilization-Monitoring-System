import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, errorText, PositionRow, View } from './api';
import { RupeePie, TrendChart } from './charts';
import { crore, day, monthLong, pct, signedCrore, signedPts } from './format';
import { MonthStrip, PaceBar, StatusWord, YearPicker } from './ui';

interface Summary extends View {
  rows: PositionRow[];
  totals: { allocatedPaise: number; spentPaise: number; utilizationPct: number };
}
type SortKey = 'gap' | 'name' | 'allocated' | 'used';

@Component({
  selector: 'app-overview',
  imports: [RouterLink, PaceBar, StatusWord, MonthStrip, YearPicker, TrendChart, RupeePie],
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (data(); as d) {
      <div class="page-head">
        <div>
          <h1>{{ finding() }}</h1>
          <p class="muted" style="margin: 0">
            Position at {{ day(d.asOf) }}, day {{ d.dayOfYear }} of {{ d.daysInYear }}.
            @if (d.publishedThrough) {
              CGA figures are published through {{ monthLong(d.publishedThrough) }}.
            }
          </p>
        </div>
        <app-year [value]="d.financialYear" (pick)="go({ fy: $event, month: null })" />
      </div>

      <app-months [months]="d.months" [selected]="d.month" (pick)="go({ month: $event })" />
      <p class="small muted" style="margin-bottom: 20px">Step through the year to see the position at the end of any month.</p>

      <section class="panel panel-flush" aria-labelledby="heads">
        <h2 id="heads" class="visually-hidden">Budget heads ranked by distance from pace</h2>
        @if (sorted().length) {
          <table>
            <thead>
              <tr>
                <th [attr.aria-sort]="ariaSort('name')"><button class="sort" (click)="sortBy('name')">Budget head</button></th>
                <th class="num hide-medium" [attr.aria-sort]="ariaSort('allocated')"><button class="sort" (click)="sortBy('allocated')">Allocated, Rs crore</button></th>
                <th style="width: 32%">Used, with time passed marked</th>
                <th class="num" [attr.aria-sort]="ariaSort('used')"><button class="sort" (click)="sortBy('used')">Used</button></th>
                <th class="num" [attr.aria-sort]="ariaSort('gap')"><button class="sort" (click)="sortBy('gap')">Gap, points</button></th>
                <th class="num hide-compact">Gap, Rs crore</th>
                <th class="num hide-medium">Open alerts</th>
              </tr>
            </thead>
            <tbody>
              @for (r of sorted(); track r.budgetId) {
                <tr>
                  <td class="name">
                    <a [routerLink]="['/departments', r.departmentId]" [queryParams]="{ fy: d.financialYear, month: d.month }" [class.strong]="r.status !== 'on'">{{ r.departmentName }}</a>
                    @if (r.status !== 'on') {
                      <span class="sub"><app-status [value]="r.status" /></span>
                    }
                  </td>
                  <td class="num hide-medium">{{ crore(r.allocatedPaise) }}</td>
                  <td><app-pace [utilization]="r.utilizationPct" [elapsed]="r.elapsedPct" [status]="r.status" /></td>
                  <td class="num">{{ pct(r.utilizationPct) }}</td>
                  <td class="num" [class]="'num ' + gapClass(r)">{{ signedPts(r.gapPts) }}</td>
                  <td class="num hide-compact" [class.muted]="r.status === 'on'">{{ signedCrore(r.gapPaise) }}</td>
                  <td class="num hide-medium">
                    @if (r.openAlerts) {
                      <a routerLink="/alerts" [queryParams]="{ departmentId: r.departmentId, fy: d.financialYear }">{{ r.openAlerts }}</a>
                    } @else {
                      <span class="muted">0</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="empty">No budgets are recorded for {{ d.financialYear }}. An Admin can add them on the Budgets page.</p>
        }
      </section>

      @if (sorted().length) {
        <div class="grid-2">
          <section class="panel">
            <h2>{{ trendTitle() }}</h2>
            <app-trend [points]="trend()" [allMonths]="monthsOfYear()" [status]="totalStatus()" />
          </section>
          <section class="panel">
            <h2>Where each rupee went</h2>
            <p class="small muted">Spending to {{ day(d.asOf) }} by category, in paise per rupee.</p>
            <app-rupee-pie [data]="slices()" />
          </section>
        </div>
      }
    } @else if (!error()) {
      <p class="muted">Loading the position…</p>
    }
  `,
})
export class Overview {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);

  protected data = signal<Summary | null>(null);
  protected trend = signal<{ month: string; cumulativePaise: number; pacePaise: number; allocatedPaise: number }[]>([]);
  protected slices = signal<{ category: string; amountPaise: number }[]>([]);
  protected error = signal('');
  protected sort = signal<{ key: SortKey; dir: 1 | -1 }>({ key: 'gap', dir: -1 });

  protected crore = (p: number) => crore(p);
  protected pct = pct;
  protected day = day;
  protected monthLong = monthLong;
  protected signedPts = signedPts;
  protected signedCrore = signedCrore;

  constructor() {
    effect(() => {
      const q = this.query();
      if (q) this.load(q.get('fy'), q.get('month'));
    });
  }

  private async load(fy: string | null, month: string | null) {
    this.error.set('');
    const params = { financialYear: fy, month };
    try {
      const [summary, trend, cats] = await Promise.all([
        this.api.get<Summary>('/dashboard/summary', params),
        this.api.get<{ months: { month: string; cumulativePaise: number; pacePaise: number; allocatedPaise: number }[] }>('/dashboard/trend', params),
        this.api.get<{ slices: { category: string; amountPaise: number }[] }>('/dashboard/categories', params),
      ]);
      this.data.set(summary);
      this.trend.set(trend.months);
      this.slices.set(cats.slices);
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected go(change: { fy?: string; month?: string | null }) {
    const current = this.data();
    this.router.navigate([], {
      queryParams: { fy: change.fy ?? current?.financialYear, month: change.month === undefined ? current?.month : change.month },
      replaceUrl: true,
    });
  }

  protected sorted = computed(() => {
    const rows = [...(this.data()?.rows ?? [])];
    const { key, dir } = this.sort();
    const value = (r: PositionRow) => ({ gap: Math.abs(r.gapPts), name: r.departmentName, allocated: r.allocatedPaise, used: r.utilizationPct })[key];
    return rows.sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0));
  });

  protected sortBy(key: SortKey) {
    const s = this.sort();
    this.sort.set({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 });
  }
  protected ariaSort = (key: SortKey) => (this.sort().key === key ? (this.sort().dir === 1 ? 'ascending' : 'descending') : null);
  protected gapClass = (r: PositionRow) => (r.status === 'on' ? 'muted' : `gap-${r.status}`);

  protected finding = computed(() => {
    const d = this.data();
    if (!d?.rows.length) return `Financial year ${d?.financialYear ?? ''}`;
    const off = d.rows.filter((r) => r.status !== 'on').length;
    if (d.rows.length === 1) return `${d.rows[0].departmentName} is ${off ? 'off pace' : 'on pace'}`;
    return off ? `${off} of ${d.rows.length} budget heads ${off === 1 ? 'is' : 'are'} off pace` : `All ${d.rows.length} budget heads are on pace`;
  });

  protected monthsOfYear = computed(() => this.data()?.months.map((m) => m.month) ?? []);
  protected totalStatus = computed(() => {
    const d = this.data();
    if (!d) return 'on';
    const gap = d.totals.utilizationPct - d.elapsedPct;
    return gap < -15 ? 'behind' : gap > 15 ? 'ahead' : 'on';
  });
  protected trendTitle = computed(() => {
    const d = this.data();
    if (!d) return '';
    const gap = d.totals.utilizationPct - d.elapsedPct;
    return `${d.rows.length > 1 ? 'All heads together: ' : ''}${pct(d.totals.utilizationPct)} used, ${Math.abs(gap).toFixed(2)} points ${gap < 0 ? 'behind' : 'ahead of'} an even pace`;
  });
}
