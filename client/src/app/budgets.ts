import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, AuditEntry, Budget, Department, errorText, Paged } from './api';
import { Auth } from './auth';
import { crore, currentFinancialYear, dateTime, money, parseRupees, pct } from './format';
import { YearPicker } from './ui';

@Component({
  selector: 'app-budgets',
  imports: [FormsModule, RouterLink, YearPicker],
  template: `
    <div class="page-head">
      <div>
        <h1>Budgets</h1>
        <p class="lede">Allocations for {{ fy() }}, with every change and its reason.</p>
      </div>
      <div class="toolbar">
        <app-year [value]="fy()" (pick)="setQuery({ fy: $event })" />
        @if (departments().length > 1) {
          <div class="field-inline">
            <label for="dept">Department</label>
            <select id="dept" (change)="setQuery({ departmentId: $any($event.target).value || null })">
              <option value="">All</option>
              @for (dpt of departments(); track dpt.id) {
                <option [value]="dpt.id" [selected]="dpt.id === departmentId()">{{ dpt.name }}</option>
              }
            </select>
          </div>
        }
        @if (isAdmin) {
          <button type="button" (click)="openCreate()">New budget</button>
        }
      </div>
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <section class="panel panel-flush">
      <table>
        <thead>
          <tr>
            <th>Department</th>
            <th>Project</th>
            <th class="num">Allocated, Rs crore</th>
            <th class="num">Spent, Rs crore</th>
            <th class="num">Used</th>
            <th class="hide-compact">Quarterly split, Rs crore</th>
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (b of budgets(); track b.id) {
            <tr>
              <td class="name"><a [routerLink]="['/departments', b.departmentId]" [queryParams]="{ fy: b.financialYear }">{{ deptName(b.departmentId) }}</a></td>
              <td>{{ b.project || '' }}<span class="muted">{{ b.project ? '' : 'Department budget' }}</span></td>
              <td class="num">{{ crore(b.allocatedPaise) }}</td>
              <td class="num">{{ crore(b.spentPaise) }}</td>
              <td class="num">{{ pct(b.utilizationPct) }}</td>
              <td class="hide-compact">{{ b.quarterSplit?.length ? splitText(b.quarterSplit!) : '' }}<span class="muted">{{ b.quarterSplit?.length ? '' : 'Not split' }}</span></td>
              <td class="num"><button type="button" class="link" (click)="openDetail(b)">{{ isAdmin ? 'Edit or history' : 'History' }}</button></td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="empty">No budgets for {{ fy() }}.{{ isAdmin ? ' Create the first with New budget.' : '' }}</td></tr>
          }
        </tbody>
      </table>
    </section>

    <dialog class="sheet" #createSheet aria-labelledby="create-title">
      <h2 id="create-title">New budget</h2>
      <form (ngSubmit)="create()">
        <div class="field">
          <label for="c-fy">Financial year</label>
          <input id="c-fy" name="fy" [(ngModel)]="form.financialYear" required pattern="\\d{4}-\\d{2}" />
        </div>
        <div class="field">
          <label for="c-dept">Department</label>
          <select id="c-dept" name="dept" [(ngModel)]="form.departmentId" required>
            @for (dpt of departments(); track dpt.id) {
              <option [value]="dpt.id">{{ dpt.name }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="c-project">Project (optional)</label>
          <input id="c-project" name="project" [(ngModel)]="form.project" />
          <p class="hint">Leave empty for the department's own budget. A project budget must fit inside it.</p>
        </div>
        <div class="field">
          <label for="c-amount">Annual allocation, Rs</label>
          <input id="c-amount" name="amount" inputmode="decimal" [(ngModel)]="form.amount" required />
          @if (form.amount && createPaise() === null) {
            <p class="hint error">Enter rupees, with up to two decimal places.</p>
          }
        </div>
        <fieldset class="field" style="border: 0; padding: 0; margin: 0 0 14px">
          <legend class="strong small" style="margin-bottom: 4px">Quarterly split, Rs (optional)</legend>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px">
            @for (q of [0, 1, 2, 3]; track q) {
              <input [attr.aria-label]="'Quarter ' + (q + 1)" [name]="'q' + q" inputmode="decimal" [(ngModel)]="form.quarters[q]" [placeholder]="'Q' + (q + 1)" />
            }
          </div>
          <p class="hint" aria-live="polite">{{ splitRemainder() }}</p>
        </fieldset>
        <p class="form-error" role="alert">{{ formError() }}</p>
        <div class="sheet-actions">
          <button type="submit" [disabled]="busy()">Create budget</button>
          <button type="button" class="secondary" (click)="createSheet.close()">Cancel</button>
        </div>
      </form>
    </dialog>

    <dialog class="sheet" #detailSheet aria-labelledby="detail-title">
      @if (selected(); as b) {
        <h2 id="detail-title">{{ deptName(b.departmentId) }}{{ b.project ? ', ' + b.project : '' }}, {{ b.financialYear }}</h2>
        <dl class="figures">
          <div><dt>Allocated</dt><dd>{{ money(b.allocatedPaise) }}</dd></div>
          <div><dt>Spent</dt><dd>{{ money(b.spentPaise) }}</dd></div>
        </dl>
        @if (isAdmin) {
          <form (ngSubmit)="update(b)">
            <div class="field">
              <label for="e-amount">New allocation, Rs</label>
              <input id="e-amount" name="amount" inputmode="decimal" [(ngModel)]="edit.amount" required />
            </div>
            <div class="field">
              <label for="e-reason">Reason for the change</label>
              <textarea id="e-reason" name="reason" [(ngModel)]="edit.reason" required minlength="3"></textarea>
              <p class="hint">Kept in the audit log with the old and new figures.</p>
            </div>
            <p class="form-error" role="alert">{{ formError() }}</p>
            <div class="sheet-actions">
              <button type="submit" [disabled]="busy()">Save change</button>
              @if (b.spentPaise === 0) {
                <button type="button" class="secondary" (click)="remove(b)">Delete budget</button>
              }
              <button type="button" class="secondary" (click)="detailSheet.close()">Close</button>
            </div>
          </form>
        } @else {
          <button type="button" class="secondary" (click)="detailSheet.close()">Close</button>
        }
        <h3 style="margin-top: 24px">Change history</h3>
        @for (h of history(); track h.id) {
          <div style="padding: 8px 0; border-bottom: 1px solid var(--rule)">
            <p style="margin: 0">{{ describe(h) }}</p>
            <p class="small muted" style="margin: 0">{{ h.actorName }}, {{ dateTime(h.at) }}{{ h.reason ? '. ' + h.reason : '' }}</p>
          </div>
        } @empty {
          <p class="muted">No changes recorded.</p>
        }
      }
    </dialog>
  `,
})
export class Budgets {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);
  protected isAdmin = inject(Auth).can('admin');
  private createSheet = viewChild.required<ElementRef<HTMLDialogElement>>('createSheet');
  private detailSheet = viewChild.required<ElementRef<HTMLDialogElement>>('detailSheet');

  protected fy = computed(() => this.query()?.get('fy') ?? currentFinancialYear());
  protected departmentId = computed(() => this.query()?.get('departmentId') ?? '');
  protected budgets = signal<Budget[]>([]);
  protected departments = signal<Department[]>([]);
  protected selected = signal<Budget | null>(null);
  protected history = signal<AuditEntry[]>([]);
  protected error = signal('');
  protected formError = signal('');
  protected busy = signal(false);
  protected form = { financialYear: currentFinancialYear(), departmentId: '', project: '', amount: '', quarters: ['', '', '', ''] };
  protected edit = { amount: '', reason: '' };

  protected crore = (p: number) => crore(p, 2);
  protected money = money;
  protected pct = pct;
  protected dateTime = dateTime;

  constructor() {
    this.api.get<Department[]>('/departments').then((d) => this.departments.set(d)).catch((e) => this.error.set(errorText(e)));
    effect(() => this.load(this.fy(), this.departmentId()));
  }

  private async load(fy: string, departmentId: string) {
    try {
      const res = await this.api.get<Paged<Budget>>('/budgets', { financialYear: fy, departmentId, limit: 200 });
      this.budgets.set(res.items);
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected setQuery(change: Record<string, string | null>) {
    this.router.navigate([], { queryParams: change, queryParamsHandling: 'merge', replaceUrl: true });
  }
  protected deptName = (id: string) => this.departments().find((d) => d.id === id)?.name ?? '';
  protected splitText = (split: number[]) => split.map((q) => crore(q, 2)).join(' / ');

  protected createPaise = () => parseRupees(this.form.amount);
  protected splitRemainder = () => {
    const total = this.createPaise();
    const parts = this.form.quarters.filter((q) => q.trim());
    if (!parts.length || total === null) return 'Leave all four empty to skip the split.';
    const sum = parts.reduce((s, q) => s + (parseRupees(q) ?? 0), 0);
    const left = total - sum;
    return left === 0 && parts.length === 4 ? 'The quarters add up exactly.' : `${money(Math.abs(left))} ${left >= 0 ? 'still to assign' : 'more than the annual amount'}.`;
  };

  protected openCreate() {
    this.formError.set('');
    this.form = { financialYear: this.fy(), departmentId: this.departments()[0]?.id ?? '', project: '', amount: '', quarters: ['', '', '', ''] };
    this.createSheet().nativeElement.showModal();
  }

  protected async create() {
    const allocatedPaise = this.createPaise();
    if (allocatedPaise === null) return this.formError.set('Enter the allocation in rupees.');
    const filled = this.form.quarters.filter((q) => q.trim());
    const quarterSplit = filled.length ? this.form.quarters.map((q) => parseRupees(q || '0')) : undefined;
    if (quarterSplit && (quarterSplit.includes(null) || filled.length !== 4)) return this.formError.set('Fill all four quarters, or none.');
    this.busy.set(true);
    try {
      await this.api.post('/budgets', { financialYear: this.form.financialYear, departmentId: this.form.departmentId, project: this.form.project, allocatedPaise, quarterSplit });
      this.createSheet().nativeElement.close();
      await this.load(this.fy(), this.departmentId());
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async openDetail(b: Budget) {
    this.formError.set('');
    this.selected.set(b);
    this.edit = { amount: (b.allocatedPaise / 100).toFixed(2), reason: '' };
    this.history.set([]);
    this.detailSheet().nativeElement.showModal();
    try {
      this.history.set(await this.api.get<AuditEntry[]>(`/budgets/${b.id}/history`));
    } catch (err) {
      this.formError.set(errorText(err));
    }
  }

  protected async update(b: Budget) {
    const allocatedPaise = parseRupees(this.edit.amount);
    if (allocatedPaise === null) return this.formError.set('Enter the allocation in rupees.');
    this.busy.set(true);
    try {
      const saved = await this.api.patch<Budget>(`/budgets/${b.id}`, { allocatedPaise, reason: this.edit.reason });
      this.selected.set(saved);
      this.edit.reason = '';
      this.history.set(await this.api.get<AuditEntry[]>(`/budgets/${b.id}/history`));
      await this.load(this.fy(), this.departmentId());
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(b: Budget) {
    if (!confirm(`Delete this ${b.financialYear} budget? It has no spending, and the deletion is kept in the audit log.`)) return;
    try {
      await this.api.delete(`/budgets/${b.id}`);
      this.detailSheet().nativeElement.close();
      await this.load(this.fy(), this.departmentId());
    } catch (err) {
      this.formError.set(errorText(err));
    }
  }

  protected describe(h: AuditEntry) {
    const before = (h.before as { allocatedPaise?: number } | null)?.allocatedPaise;
    const after = (h.after as { allocatedPaise?: number } | null)?.allocatedPaise;
    if (h.action === 'create') return `Created with ${money(after ?? 0)}`;
    if (h.action === 'delete') return 'Deleted';
    return before !== undefined && after !== undefined && before !== after ? `Allocation changed from ${money(before)} to ${money(after)}` : 'Updated';
  }
}

