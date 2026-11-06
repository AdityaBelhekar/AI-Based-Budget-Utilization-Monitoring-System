import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Alert, Api, Department, errorText, Paged } from './api';
import { Auth } from './auth';
import { ALERT_TYPES, currentFinancialYear, dateTime, day } from './format';
import { StatusWord, YearPicker } from './ui';

const STATUSES: Record<string, string> = { active: 'Needs a response', open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

@Component({
  selector: 'app-alerts',
  imports: [FormsModule, RouterLink, StatusWord, YearPicker],
  template: `
    <div class="page-head">
      <div>
        <h1>Alerts</h1>
        <p class="muted" style="margin: 0">Each alert gives the rule, the figures and the threshold it crossed. Most serious first.</p>
      </div>
    </div>
    <p class="status-line" role="status">{{ status() }}</p>
    <div class="toolbar" style="margin-bottom: 12px">
      <app-year [value]="fy()" (pick)="setQuery({ fy: $event, page: null })" />
      <div class="field-inline">
        <label for="a-status">Status</label>
        <select id="a-status" (change)="setQuery({ status: $any($event.target).value, page: null })">
          @for (s of statusKeys; track s) {
            <option [value]="s" [selected]="s === statusFilter()">{{ statuses[s] }}</option>
          }
          <option value="all" [selected]="statusFilter() === 'all'">All</option>
        </select>
      </div>
      <div class="field-inline">
        <label for="a-type">Rule</label>
        <select id="a-type" (change)="setQuery({ type: $any($event.target).value || null, page: null })">
          <option value="">All</option>
          @for (t of typeKeys; track t) {
            <option [value]="t" [selected]="t === q('type')">{{ types[t] }}</option>
          }
        </select>
      </div>
      @if (departments().length > 1) {
        <div class="field-inline">
          <label for="a-dept">Budget head</label>
          <select id="a-dept" (change)="setQuery({ departmentId: $any($event.target).value || null, page: null })">
            <option value="">All</option>
            @for (dpt of departments(); track dpt.id) {
              <option [value]="dpt.id" [selected]="dpt.id === q('departmentId')">{{ dpt.name }}</option>
            }
          </select>
        </div>
      }
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <section class="panel panel-flush">
      @for (a of page()?.items ?? []; track a.id) {
        <article class="alert-item">
          <div>
            <p class="strong" style="margin-bottom: 2px">
              {{ types[a.type] }}:
              <a [routerLink]="['/departments', a.departmentId.id]" [queryParams]="{ fy: a.financialYear }">{{ a.departmentId.name }}</a>
            </p>
            <p style="margin-bottom: 6px">{{ a.message }}</p>
            <div class="alert-meta">
              <app-status [value]="a.severity" />
              <span>Detected at {{ day(a.detectedAt) }}</span>
              <span>{{ statuses[a.status] }}</span>
              @if (lastNote(a); as n) {
                <span>{{ n }}</span>
              }
            </div>
          </div>
          @if (canRespond && a.status !== 'resolved') {
            <div class="toolbar" style="align-items: start">
              @if (a.status === 'open') {
                <button type="button" class="secondary" (click)="acknowledge(a)">Acknowledge</button>
              }
              <button type="button" class="secondary" (click)="openResolve(a)">Resolve</button>
            </div>
          }
        </article>
      } @empty {
        <p class="empty">{{ statusFilter() === 'active' ? 'Nothing needs a response for ' + fy() + '.' : 'No alerts match these filters.' }}</p>
      }
      @if (page(); as p) {
        @if (p.total > p.limit) {
          <div class="pager">
            <span class="muted small">{{ (p.page - 1) * p.limit + 1 }} to {{ Math.min(p.page * p.limit, p.total) }} of {{ p.total }}</span>
            <span class="toolbar">
              <button type="button" class="secondary" [disabled]="p.page === 1" (click)="setQuery({ page: p.page - 1 })">Previous</button>
              <button type="button" class="secondary" [disabled]="p.page * p.limit >= p.total" (click)="setQuery({ page: p.page + 1 })">Next</button>
            </span>
          </div>
        }
      }
    </section>

    <dialog class="sheet" #resolveSheet aria-labelledby="resolve-title">
      @if (selected(); as a) {
        <h2 id="resolve-title">Resolve: {{ types[a.type] }}</h2>
        <p>{{ a.message }}</p>
        <form (ngSubmit)="resolve(a)">
          <div class="field">
            <label for="r-note">What was done</label>
            <textarea id="r-note" name="note" [(ngModel)]="note" required minlength="3"></textarea>
            <p class="hint">Kept with the alert and in the audit log. A resolved alert is not raised again for the same period.</p>
          </div>
          <p class="form-error" role="alert">{{ formError() }}</p>
          <div class="sheet-actions">
            <button type="submit" [disabled]="busy()">Resolve alert</button>
            <button type="button" class="secondary" (click)="resolveSheet.close()">Cancel</button>
          </div>
        </form>
        <h3 style="margin-top: 24px">History</h3>
        @for (h of a.history; track $index) {
          <p class="small" style="margin-bottom: 4px">{{ h.action }}{{ h.severity ? ' (' + h.severity + ')' : '' }}{{ h.actorName ? ' by ' + h.actorName : '' }}, {{ dateTime(h.at) }}{{ h.note ? ': ' + h.note : '' }}</p>
        }
      }
    </dialog>
  `,
})
export class Alerts {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);
  protected canRespond = inject(Auth).can('finance_officer', 'department_head');
  protected resolveSheet = viewChild.required<ElementRef<HTMLDialogElement>>('resolveSheet');

  protected page = signal<Paged<Alert> | null>(null);
  protected departments = signal<Department[]>([]);
  protected selected = signal<Alert | null>(null);
  protected error = signal('');
  protected formError = signal('');
  protected status = signal('');
  protected busy = signal(false);
  protected note = '';

  protected types = ALERT_TYPES;
  protected typeKeys = Object.keys(ALERT_TYPES);
  protected statuses = STATUSES;
  protected statusKeys = Object.keys(STATUSES);
  protected Math = Math;
  protected day = day;
  protected dateTime = dateTime;

  protected fy = computed(() => this.query()?.get('fy') ?? currentFinancialYear());
  protected statusFilter = computed(() => this.query()?.get('status') ?? 'active');
  protected q = (key: string) => this.query()?.get(key) ?? '';

  constructor() {
    this.api.get<Department[]>('/departments').then((d) => this.departments.set(d)).catch(() => undefined);
    effect(() => {
      if (this.query()) this.load();
    });
  }

  private async load() {
    this.error.set('');
    try {
      const status = this.statusFilter();
      this.page.set(
        await this.api.get<Paged<Alert>>('/alerts', {
          financialYear: this.fy(),
          status: status === 'all' ? null : status,
          type: this.q('type'),
          departmentId: this.q('departmentId'),
          page: this.q('page') || 1,
          limit: 30,
        }),
      );
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected setQuery(change: Record<string, string | number | null>) {
    this.router.navigate([], { queryParams: change, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected lastNote = (a: Alert) => {
    const h = [...a.history].reverse().find((x) => x.actorName);
    return h ? `${h.action} by ${h.actorName}` : '';
  };

  protected async acknowledge(a: Alert) {
    try {
      await this.api.patch(`/alerts/${a.id}`, { action: 'acknowledge' });
      this.status.set(`Acknowledged: ${ALERT_TYPES[a.type]}, ${a.departmentId.name}.`);
      await this.load();
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected openResolve(a: Alert) {
    this.selected.set(a);
    this.note = '';
    this.formError.set('');
    this.resolveSheet().nativeElement.showModal();
  }

  protected async resolve(a: Alert) {
    this.busy.set(true);
    try {
      await this.api.patch(`/alerts/${a.id}`, { action: 'resolve', note: this.note });
      this.resolveSheet().nativeElement.close();
      this.status.set(`Resolved: ${ALERT_TYPES[a.type]}, ${a.departmentId.name}.`);
      await this.load();
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }
}
