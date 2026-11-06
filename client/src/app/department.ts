import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Alert, Api, Department as Dept, errorText, PositionRow, View } from './api';
import { Auth } from './auth';
import { MonthlyBars, TrendChart } from './charts';
import { ALERT_TYPES, crore, day, money, pct, signedPts } from './format';
import { MonthStrip, PaceBar, StatusWord, YearPicker } from './ui';

interface DepartmentView extends View {
  department: Dept;
  position: PositionRow | null;
  projects: { budgetId: string; project: string; allocatedPaise: number; spentPaise: number; utilizationPct: number }[];
  monthly: { month: string; amountPaise: number; spike: string | null }[];
  alerts: Alert[];
}

@Component({
  selector: 'app-department',
  imports: [RouterLink, PaceBar, StatusWord, MonthStrip, YearPicker, MonthlyBars, TrendChart],
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (data(); as d) {
      <p class="small"><a routerLink="/" [queryParams]="{ fy: d.financialYear, month: d.month }">Overview</a></p>
      <div class="page-head">
        <div>
          <h1>{{ d.department.name }}</h1>
          <p class="muted" style="margin: 0">{{ d.department.sourceNote }}</p>
        </div>
        <app-year [value]="d.financialYear" (pick)="go({ fy: $event, month: null })" />
      </div>
      <app-months [months]="d.months" [selected]="d.month" (pick)="go({ month: $event })" />

      @if (d.position; as p) {
        <section class="panel" style="margin-top: 16px">
          <h2>{{ finding(p) }}</h2>
          <dl class="figures">
            <div><dt>Allocated</dt><dd>{{ money(p.allocatedPaise) }}</dd></div>
            <div><dt>Spent to {{ day(d.asOf) }}</dt><dd>{{ money(p.spentPaise) }}</dd></div>
            <div><dt>Remaining</dt><dd>{{ money(p.remainingPaise) }}</dd></div>
            <div><dt>Year passed</dt><dd>{{ pct(d.elapsedPct) }}</dd></div>
            <div><dt>Status</dt><dd><app-status [value]="p.status" /></dd></div>
          </dl>
          <app-pace [utilization]="p.utilizationPct" [elapsed]="p.elapsedPct" [status]="p.status" [large]="true" />
          <p class="small muted" style="margin: 12px 0 0">
            The mark shows how much of the year has passed. The pace limit for this head is {{ p.paceLimitPts }} points.
            @if (p.sourceUrl) {
              <a [href]="p.sourceUrl" target="_blank" rel="noopener">Source: CGA</a>
            }
          </p>
          <div class="toolbar" style="margin-top: 16px">
            @if (canSpend) {
              <a class="button secondary" routerLink="/expenditure" [queryParams]="{ departmentId: d.department.id, fy: d.financialYear }">Expenditure records</a>
            }
            <a class="button secondary" routerLink="/budgets" [queryParams]="{ fy: d.financialYear, departmentId: d.department.id }">Budget and change history</a>
          </div>
        </section>

        <div class="grid-2">
          <section class="panel">
            <h2>Spending by month</h2>
            <app-monthly-bars [bars]="d.monthly" [allMonths]="monthsOfYear()" />
          </section>
          <section class="panel">
            <h2>Spending against an even pace</h2>
            <app-trend [points]="trend()" [allMonths]="monthsOfYear()" [status]="p.status" />
          </section>
        </div>
      } @else {
        <p class="panel empty">No budget is recorded for this department in {{ d.financialYear }}.</p>
      }

      <section class="panel panel-flush">
        <h2 style="padding: 16px 16px 0">Open alerts</h2>
        @for (a of d.alerts; track a.id) {
          <div class="alert-item">
            <div>
              <p class="strong" style="margin-bottom: 2px">{{ types[a.type] }}</p>
              <p style="margin-bottom: 4px">{{ a.message }}</p>
              <div class="alert-meta"><app-status [value]="a.severity" /> <span>Detected at {{ day(a.detectedAt) }}</span> <span>{{ a.status === 'open' ? 'Open' : 'Acknowledged' }}</span></div>
            </div>
            <a routerLink="/alerts" [queryParams]="{ departmentId: d.department.id, fy: d.financialYear }">Respond</a>
          </div>
        } @empty {
          <p class="empty">No open alerts for {{ d.financialYear }}.</p>
        }
      </section>

      @if (d.projects.length) {
        <section class="panel panel-flush">
          <h2 style="padding: 16px 16px 0">Projects</h2>
          <table>
            <thead><tr><th>Project</th><th class="num">Allocated, Rs crore</th><th class="num">Spent, Rs crore</th><th class="num">Used</th></tr></thead>
            <tbody>
              @for (pr of d.projects; track pr.budgetId) {
                <tr><td>{{ pr.project }}</td><td class="num">{{ crore(pr.allocatedPaise) }}</td><td class="num">{{ crore(pr.spentPaise) }}</td><td class="num">{{ pct(pr.utilizationPct) }}</td></tr>
              }
            </tbody>
          </table>
        </section>
      }
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }
  `,
})
export class DepartmentPage {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private params = toSignal(this.route.paramMap);
  private query = toSignal(this.route.queryParamMap);
  protected canSpend = inject(Auth).can('finance_officer', 'department_head');

  protected data = signal<DepartmentView | null>(null);
  protected trend = signal<{ month: string; cumulativePaise: number; pacePaise: number; allocatedPaise: number }[]>([]);
  protected error = signal('');
  protected types = ALERT_TYPES;
  protected money = money;
  protected crore = (p: number) => crore(p, 2);
  protected pct = pct;
  protected day = day;

  constructor() {
    effect(() => {
      const id = this.params()?.get('id');
      const q = this.query();
      if (id && q) this.load(id, q.get('fy'), q.get('month'));
    });
  }

  private async load(id: string, fy: string | null, month: string | null) {
    this.error.set('');
    try {
      const params = { financialYear: fy, month };
      const [view, trend] = await Promise.all([
        this.api.get<DepartmentView>(`/dashboard/departments/${id}`, params),
        this.api.get<{ months: { month: string; cumulativePaise: number; pacePaise: number; allocatedPaise: number }[] }>('/dashboard/trend', { ...params, departmentId: id }),
      ]);
      this.data.set(view);
      this.trend.set(trend.months);
    } catch (err) {
      this.data.set(null);
      this.error.set(errorText(err));
    }
  }

  protected go(change: { fy?: string; month?: string | null }) {
    const d = this.data();
    this.router.navigate([], { queryParams: { fy: change.fy ?? d?.financialYear, month: change.month === undefined ? d?.month : change.month }, replaceUrl: true });
  }

  protected monthsOfYear = computed(() => this.data()?.months.map((m) => m.month) ?? []);
  protected finding = (p: PositionRow) =>
    p.status === 'over'
      ? `Over budget: ${pct(p.utilizationPct)} of the allocation spent`
      : `${pct(p.utilizationPct)} used with ${pct(p.elapsedPct)} of the year passed, ${Math.abs(p.gapPts).toFixed(2)} points ${p.gapPts < 0 ? 'behind' : 'ahead of'} pace (${money(Math.abs(p.gapPaise))})`;
  protected signedPts = signedPts;
}
