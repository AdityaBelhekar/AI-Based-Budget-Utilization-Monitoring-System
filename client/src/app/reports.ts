import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, errorText, View } from './api';
import { ALERT_TYPES, currentFinancialYear, money, monthLong } from './format';
import { MonthStrip, YearPicker } from './ui';

const REPORTS: Record<string, { name: string; about: string }> = {
  utilization: { name: 'Utilization by budget head', about: 'Allocated, spent, remaining, pace gap and open alerts for each head.' },
  transactions: { name: 'Expenditure ledger', about: 'Every record to the chosen date, including reversals and published months.' },
  alerts: { name: 'Alerts', about: 'Every alert raised in the year, with its finding and status.' },
};

interface Report {
  title: string;
  columns: { key: string; label: string; align?: string }[];
  rows: Record<string, string | number>[];
  note: string;
  view: View;
}

interface Kpis {
  alertsByType: Record<string, number>;
  medianResponseHours: number | null;
  respondedAlerts: number;
  unspentAtYearEnd: { unspentPaise: number; flaggedBeforeQ4Paise: number; sharePct: number | null; years: string[] };
}

@Component({
  selector: 'app-reports',
  imports: [MonthStrip, YearPicker],
  template: `
    <div class="page-head">
      <div>
        <h1>Reports</h1>
        <p class="lede">Downloads use the same figures as the screen.</p>
      </div>
      <app-year [value]="fy()" (pick)="setQuery({ fy: $event, month: null })" />
    </div>

    <div class="tabs" role="tablist">
      @for (key of reportKeys; track key) {
        <button type="button" role="tab" [attr.aria-selected]="key === type()" (click)="setQuery({ type: key })">{{ reports[key].name }}</button>
      }
    </div>
    @if (report()?.view; as v) {
      @if (type() !== 'alerts') {
        <app-months [months]="v.months" [selected]="v.month" (pick)="setQuery({ month: $event })" />
      }
    }

    <div class="page-head" style="margin-top: 16px">
      <p class="lede">{{ reports[type()].about }}</p>
      <div class="toolbar">
        <a class="button" [href]="download('csv')" download>Download CSV</a>
        <a class="button secondary" [href]="download('pdf')" download>Download PDF</a>
      </div>
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (report(); as r) {
      <section class="panel panel-flush">
        <div class="panel-head"><h2>{{ r.title }}</h2></div>
        <p class="small muted" style="padding: 0 24px 8px">{{ r.note }}{{ r.rows.length > previewRows ? ' The preview shows the first ' + previewRows + ' rows; the download has all of them.' : '' }}</p>
        <table class="report">
          <thead>
            <tr>
              @for (c of r.columns; track c.key) {
                <th [class.num]="c.align === 'right'">{{ c.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of r.rows.slice(0, previewRows); track $index) {
              <tr>
                @for (c of r.columns; track c.key) {
                  <td [class.num]="c.align === 'right'">{{ show(row[c.key]) }}</td>
                }
              </tr>
            } @empty {
              <tr><td [attr.colspan]="r.columns.length" class="empty">Nothing to report for this period.</td></tr>
            }
          </tbody>
        </table>
      </section>
    }

    @if (kpis(); as k) {
      <section class="panel">
        <h2>How the monitoring performs</h2>
        <dl class="figures">
          <div>
            <dt>Year-end unspent money flagged before January</dt>
            <dd>
              {{ k.unspentAtYearEnd.sharePct === null ? 'No closed years' : k.unspentAtYearEnd.sharePct + '%' }}
            </dd>
          </div>
          <div><dt>Median time to first response</dt><dd>{{ k.medianResponseHours === null ? 'No responses yet' : k.medianResponseHours + ' hours' }}</dd></div>
          <div><dt>Alerts responded to</dt><dd>{{ k.respondedAlerts }}</dd></div>
        </dl>
        @if (k.unspentAtYearEnd.sharePct !== null) {
          <p class="small muted">
            Of {{ money(k.unspentAtYearEnd.unspentPaise) }} left unspent at the end of {{ k.unspentAtYearEnd.years.join(', ') }},
            {{ money(k.unspentAtYearEnd.flaggedBeforeQ4Paise) }} sat in budgets that had an under-use warning before the last quarter began.
          </p>
        }
        <h3>Alerts raised, by rule, all years</h3>
        <table>
          <tbody>
            @for (t of typeKeys; track t) {
              <tr><td>{{ types[t] }}</td><td class="num">{{ k.alertsByType[t] ?? 0 }}</td></tr>
            }
          </tbody>
        </table>
      </section>
    }
  `,
})
export class Reports {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);

  protected report = signal<Report | null>(null);
  protected kpis = signal<Kpis | null>(null);
  protected error = signal('');
  protected previewRows = 200;
  protected reports = REPORTS;
  protected reportKeys = Object.keys(REPORTS);
  protected types = ALERT_TYPES;
  protected typeKeys = Object.keys(ALERT_TYPES);
  protected money = money;
  protected monthLong = monthLong;

  protected type = computed(() => {
    const t = this.query()?.get('type') ?? 'utilization';
    return REPORTS[t] ? t : 'utilization';
  });
  protected fy = computed(() => this.query()?.get('fy') ?? currentFinancialYear());
  private month = computed(() => this.query()?.get('month') ?? null);

  constructor() {
    this.api.get<Kpis>('/dashboard/kpis').then((k) => this.kpis.set(k)).catch(() => undefined);
    effect(() => this.load(this.type(), this.fy(), this.month()));
  }

  private async load(type: string, fy: string, month: string | null) {
    this.error.set('');
    try {
      this.report.set(await this.api.get<Report>(`/reports/${type}`, { financialYear: fy, month }));
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected download = (format: 'csv' | 'pdf') => this.api.url(`/reports/${this.type()}`, { financialYear: this.fy(), month: this.report()?.view.month ?? this.month(), format });
  protected show = (v: string | number) => (typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v);

  protected setQuery(change: Record<string, string | null>) {
    this.router.navigate([], { queryParams: change, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
