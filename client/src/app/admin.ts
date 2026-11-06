import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, AuditEntry, Department, errorText, Paged } from './api';
import { Auth, ROLE_LABELS, Role, User } from './auth';
import { ALERT_TYPES, dateTime } from './format';

type Tab = 'users' | 'departments' | 'thresholds' | 'audit';
type Values = Record<string, Record<string, number>>;

// Labels for each threshold, in the words the PRD uses for the rules.
const FIELDS: { rule: string; key: string; label: string; unit: string }[] = [
  { rule: 'underUtilization', key: 'minElapsedPct', label: 'Under-utilization: check once this much of the year has passed', unit: '%' },
  { rule: 'underUtilization', key: 'maxUtilizationPct', label: 'Under-utilization: flag when less than this is used', unit: '%' },
  { rule: 'pace', key: 'startElapsedPct', label: 'Pace: start checking after this much of the year', unit: '%' },
  { rule: 'pace', key: 'maxGapPts', label: 'Pace: flag a gap larger than', unit: 'points' },
  { rule: 'overspending', key: 'warnPct', label: 'Overspending: warn from', unit: '% used' },
  { rule: 'dormant', key: 'days', label: 'Dormant funds: flag after no spending for', unit: 'days' },
  { rule: 'dormant', key: 'minRemainingPct', label: 'Dormant funds: only while more than this is unspent', unit: '%' },
  { rule: 'yearEndRush', key: 'q4MaxPct', label: 'Year-end rush: January to March ceiling', unit: '% of allocation' },
  { rule: 'yearEndRush', key: 'marchMaxPct', label: 'Year-end rush: March ceiling', unit: '% of allocation' },
  { rule: 'duplicate', key: 'windowDays', label: 'Possible duplicate: same amount within', unit: 'days' },
  { rule: 'spike', key: 'zLimit', label: 'Spike: modified z-score limit', unit: '' },
  { rule: 'spike', key: 'minHistoryMonths', label: 'Spike: months of history needed', unit: 'months' },
  { rule: 'spike', key: 'singleTxnPct', label: 'Spike: single expense above', unit: '% of allocation' },
];

@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  template: `
    <div class="page-head">
      <div>
        <h1>Administration</h1>
        <p class="muted" style="margin: 0">{{ isAdmin ? 'People, departments, alert thresholds and the audit log.' : 'The audit log of every financial and administrative change.' }}</p>
      </div>
    </div>
    @if (isAdmin) {
      <div class="tabs" role="tablist">
        @for (t of tabs; track t.key) {
          <button type="button" role="tab" [attr.aria-selected]="t.key === tab()" (click)="setQuery({ tab: t.key, page: null })">{{ t.label }}</button>
        }
      </div>
    }
    <p class="status-line" role="status">{{ status() }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @switch (tab()) {
      @case ('users') {
        <div class="toolbar" style="margin-bottom: 12px"><button type="button" (click)="openUser(null)">Add person</button></div>
        <section class="panel panel-flush">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr>
                  <td>{{ u.name }}</td>
                  <td>{{ u.email }}</td>
                  <td>{{ roles[u.role] }}</td>
                  <td>{{ deptName(u.departmentId) }}</td>
                  <td [class.muted]="!u.active">{{ u.active ? 'Active' : 'Deactivated' }}</td>
                  <td class="num"><button type="button" class="link" (click)="openUser(u)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
      @case ('departments') {
        <div class="toolbar" style="margin-bottom: 12px"><button type="button" (click)="openDept(null)">Add department</button></div>
        <section class="panel panel-flush">
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Note</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (d of departments(); track d.id) {
                <tr>
                  <td>{{ d.name }}</td>
                  <td>{{ d.code }}</td>
                  <td class="small muted">{{ d.sourceNote }}</td>
                  <td [class.muted]="!d.active">{{ d.active ? 'Active' : 'Deactivated' }}</td>
                  <td class="num"><button type="button" class="link" (click)="openDept(d)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
      @case ('thresholds') {
        <section class="panel">
          <div class="toolbar" style="margin-bottom: 16px">
            <div class="field-inline">
              <label for="t-scope">Applies to</label>
              <select id="t-scope" [ngModel]="scope()" (ngModelChange)="pickScope($event)" name="scope">
                <option value="">All departments</option>
                @for (d of departments(); track d.id) {
                  <option [value]="d.id">{{ d.name }} only</option>
                }
              </select>
            </div>
            <button type="button" class="secondary" (click)="runScan()" [disabled]="busy()">Run a scan now</button>
          </div>
          <p class="small muted">Changes apply to future scans. Existing alerts keep the figures and threshold they fired with.</p>
          <form (ngSubmit)="saveThresholds()">
            <table>
              <tbody>
                @for (f of fields; track f.rule + f.key) {
                  <tr>
                    <td><label [for]="'t-' + f.rule + f.key" style="font-weight: 400; margin: 0">{{ f.label }}</label></td>
                    <td style="width: 140px"><input [id]="'t-' + f.rule + f.key" type="number" min="0" step="any" [name]="f.rule + f.key" [(ngModel)]="values[f.rule][f.key]" /></td>
                    <td class="muted small" style="width: 130px">{{ f.unit }}</td>
                  </tr>
                }
              </tbody>
            </table>
            @if (preview(); as p) {
              <h3 style="margin-top: 16px">What this change would do in {{ p.financialYear }}</h3>
              <table>
                <thead><tr><th>Rule</th><th class="num">Findings now</th><th class="num">With these values</th></tr></thead>
                <tbody>
                  @for (t of typeKeys; track t) {
                    <tr><td>{{ types[t] }}</td><td class="num">{{ p.current[t] }}</td><td class="num" [class.strong]="p.current[t] !== p.proposed[t]">{{ p.proposed[t] }}</td></tr>
                  }
                </tbody>
              </table>
            }
            <div class="sheet-actions" style="margin-top: 16px">
              <button type="button" class="secondary" (click)="previewThresholds()" [disabled]="busy()">Preview effect</button>
              <button type="submit" [disabled]="busy()">Save thresholds</button>
            </div>
          </form>
        </section>
      }
      @default {
        <div class="toolbar" style="margin-bottom: 12px">
          <div class="field-inline">
            <label for="l-entity">Record type</label>
            <select id="l-entity" (change)="setQuery({ entity: $any($event.target).value || null, page: null })">
              <option value="">All</option>
              @for (e of entities; track e) {
                <option [value]="e" [selected]="e === q('entity')">{{ e }}</option>
              }
            </select>
          </div>
          <div class="field-inline"><label for="l-from">From</label><input id="l-from" type="date" [value]="q('from')" (change)="setQuery({ from: $any($event.target).value || null, page: null })" /></div>
          <div class="field-inline"><label for="l-to">To</label><input id="l-to" type="date" [value]="q('to')" (change)="setQuery({ to: $any($event.target).value || null, page: null })" /></div>
        </div>
        <section class="panel panel-flush">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th></tr></thead>
            <tbody>
              @for (e of audit()?.items ?? []; track e.id) {
                <tr>
                  <td class="nowrap">{{ dateTime(e.at) }}</td>
                  <td>{{ e.actorName }}</td>
                  <td>{{ e.action }} {{ e.entity }}<span class="sub">{{ summary(e) }}</span></td>
                  <td class="small">{{ e.reason }}</td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="empty">No changes match these filters.</td></tr>
              }
            </tbody>
          </table>
          @if (audit(); as p) {
            <div class="pager">
              <span class="muted small">{{ p.total }} entries. No entry can be edited or deleted.</span>
              <span class="toolbar">
                <button type="button" class="secondary" [disabled]="p.page === 1" (click)="setQuery({ page: p.page - 1 })">Previous</button>
                <button type="button" class="secondary" [disabled]="p.page * p.limit >= p.total" (click)="setQuery({ page: p.page + 1 })">Next</button>
              </span>
            </div>
          }
        </section>
      }
    }

    <dialog class="sheet" #userSheet aria-labelledby="user-title">
      <h2 id="user-title">{{ editingUser() ? 'Edit ' + editingUser()!.name : 'Add person' }}</h2>
      <form (ngSubmit)="saveUser()">
        <div class="field"><label for="u-name">Name</label><input id="u-name" name="name" [(ngModel)]="userForm.name" required /></div>
        @if (!editingUser()) {
          <div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" autocomplete="off" [(ngModel)]="userForm.email" required /></div>
        }
        <div class="field">
          <label for="u-role">Role</label>
          <select id="u-role" name="role" [(ngModel)]="userForm.role">
            @for (r of roleKeys; track r) {
              <option [value]="r">{{ roles[r] }}</option>
            }
          </select>
        </div>
        @if (userForm.role === 'department_head') {
          <div class="field">
            <label for="u-dept">Department</label>
            <select id="u-dept" name="dept" [(ngModel)]="userForm.departmentId" required>
              @for (d of departments(); track d.id) {
                <option [value]="d.id">{{ d.name }}</option>
              }
            </select>
          </div>
        }
        <div class="field">
          <label for="u-pass">{{ editingUser() ? 'New password (leave empty to keep)' : 'Password' }}</label>
          <input id="u-pass" name="password" type="password" autocomplete="new-password" [(ngModel)]="userForm.password" [required]="!editingUser()" minlength="12" />
          <p class="hint">At least 12 characters. Share it with the person directly.</p>
        </div>
        @if (editingUser()) {
          <div class="field">
            <label><input type="checkbox" name="active" [(ngModel)]="userForm.active" style="display: inline; width: auto; min-height: 0; margin-right: 6px" />Active</label>
            <p class="hint">A deactivated person is signed out on their next request.</p>
          </div>
        }
        <p class="form-error" role="alert">{{ formError() }}</p>
        <div class="sheet-actions">
          <button type="submit" [disabled]="busy()">{{ editingUser() ? 'Save changes' : 'Add person' }}</button>
          <button type="button" class="secondary" (click)="userSheet.close()">Cancel</button>
        </div>
      </form>
    </dialog>

    <dialog class="sheet" #deptSheet aria-labelledby="dept-title">
      <h2 id="dept-title">{{ editingDept() ? 'Edit ' + editingDept()!.name : 'Add department' }}</h2>
      <form (ngSubmit)="saveDept()">
        <div class="field"><label for="d-name">Name</label><input id="d-name" name="name" [(ngModel)]="deptForm.name" required /></div>
        @if (!editingDept()) {
          <div class="field"><label for="d-code">Code</label><input id="d-code" name="code" [(ngModel)]="deptForm.code" required minlength="2" maxlength="20" /></div>
        }
        <div class="field"><label for="d-note">Note</label><textarea id="d-note" name="note" [(ngModel)]="deptForm.sourceNote" maxlength="500"></textarea></div>
        @if (editingDept()) {
          <div class="field">
            <label><input type="checkbox" name="active" [(ngModel)]="deptForm.active" style="display: inline; width: auto; min-height: 0; margin-right: 6px" />Active</label>
            <p class="hint">Departments are never deleted, so their history stays readable.</p>
          </div>
        }
        <p class="form-error" role="alert">{{ formError() }}</p>
        <div class="sheet-actions">
          <button type="submit" [disabled]="busy()">{{ editingDept() ? 'Save changes' : 'Add department' }}</button>
          <button type="button" class="secondary" (click)="deptSheet.close()">Cancel</button>
        </div>
      </form>
    </dialog>
  `,
})
export class Admin {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);
  protected isAdmin = inject(Auth).can('admin');
  protected userSheet = viewChild.required<ElementRef<HTMLDialogElement>>('userSheet');
  protected deptSheet = viewChild.required<ElementRef<HTMLDialogElement>>('deptSheet');

  protected tabs: { key: Tab; label: string }[] = [
    { key: 'users', label: 'People' },
    { key: 'departments', label: 'Departments' },
    { key: 'thresholds', label: 'Alert thresholds' },
    { key: 'audit', label: 'Audit log' },
  ];
  protected tab = computed<Tab>(() => {
    const t = this.query()?.get('tab') as Tab | null;
    return this.isAdmin ? (t ?? 'users') : 'audit';
  });
  protected q = (key: string) => this.query()?.get(key) ?? '';

  protected users = signal<User[]>([]);
  protected departments = signal<Department[]>([]);
  protected audit = signal<Paged<AuditEntry> | null>(null);
  protected preview = signal<{ financialYear: string; current: Record<string, number>; proposed: Record<string, number> } | null>(null);
  protected scope = signal('');
  protected editingUser = signal<User | null>(null);
  protected editingDept = signal<Department | null>(null);
  protected error = signal('');
  protected formError = signal('');
  protected status = signal('');
  protected busy = signal(false);

  protected roles = ROLE_LABELS;
  protected roleKeys = Object.keys(ROLE_LABELS) as Role[];
  protected types = ALERT_TYPES;
  protected typeKeys = Object.keys(ALERT_TYPES);
  protected fields = FIELDS;
  protected entities = ['alert', 'budget', 'department', 'scan', 'threshold', 'transaction', 'user'];
  protected dateTime = dateTime;
  protected values: Values = {};
  private thresholdData: { global: Values; overrides: { departmentId: string; values: Values }[] } | null = null;
  protected userForm = { name: '', email: '', role: 'finance_officer' as Role, departmentId: '', password: '', active: true };
  protected deptForm = { name: '', code: '', sourceNote: '', active: true };

  constructor() {
    this.api.get<Department[]>('/departments').then((d) => this.departments.set(d)).catch((e) => this.error.set(errorText(e)));
    effect(() => {
      if (!this.query()) return;
      const tab = this.tab();
      this.error.set('');
      if (tab === 'users') this.loadUsers();
      if (tab === 'thresholds') this.loadThresholds();
      if (tab === 'audit') this.loadAudit();
    });
  }

  protected setQuery(change: Record<string, string | number | null>) {
    this.router.navigate([], { queryParams: change, queryParamsHandling: 'merge', replaceUrl: true });
  }
  protected deptName = (id: string | null) => this.departments().find((d) => d.id === id)?.name ?? '';

  private async loadUsers() {
    this.users.set(await this.api.get<User[]>('/users').catch((e) => (this.error.set(errorText(e)), [])));
  }

  private async loadAudit() {
    try {
      this.audit.set(await this.api.get<Paged<AuditEntry>>('/audit-logs', { entity: this.q('entity'), from: this.q('from'), to: this.q('to'), page: this.q('page') || 1, limit: 50 }));
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  private async loadThresholds() {
    try {
      this.thresholdData = await this.api.get('/thresholds');
      this.pickScope(this.scope());
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected pickScope(departmentId: string) {
    this.scope.set(departmentId);
    this.preview.set(null);
    const data = this.thresholdData;
    if (!data) return;
    const override = data.overrides.find((o) => o.departmentId === departmentId)?.values ?? {};
    this.values = Object.fromEntries(Object.entries(data.global).map(([rule, v]) => [rule, { ...v, ...(override[rule] ?? {}) }]));
  }

  protected async previewThresholds() {
    this.busy.set(true);
    try {
      this.preview.set(await this.api.post('/thresholds/preview', { departmentId: this.scope() || null, values: this.values }));
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveThresholds() {
    this.busy.set(true);
    try {
      await this.api.put('/thresholds', { departmentId: this.scope() || null, values: this.values });
      this.status.set(`Saved thresholds for ${this.scope() ? this.deptName(this.scope()) : 'all departments'}. They apply from the next scan.`);
      await this.loadThresholds();
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async runScan() {
    this.busy.set(true);
    try {
      const r = await this.api.post<{ budgetsChecked: number; findings: number; raised: number; escalated: number }>('/scans/run');
      this.status.set(`Scanned ${r.budgetsChecked} budgets: ${r.raised} new alerts, ${r.escalated} made more serious.`);
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected openUser(u: User | null) {
    this.formError.set('');
    this.editingUser.set(u);
    this.userForm = u
      ? { name: u.name, email: u.email, role: u.role, departmentId: u.departmentId ?? '', password: '', active: u.active ?? true }
      : { name: '', email: '', role: 'finance_officer', departmentId: this.departments()[0]?.id ?? '', password: '', active: true };
    this.userSheet().nativeElement.showModal();
  }

  protected async saveUser() {
    this.busy.set(true);
    const f = this.userForm;
    const departmentId = f.role === 'department_head' ? f.departmentId : null;
    try {
      const editing = this.editingUser();
      if (editing) {
        await this.api.patch(`/users/${editing.id}`, { name: f.name, role: f.role, departmentId, active: f.active, ...(f.password ? { password: f.password } : {}) });
      } else {
        await this.api.post('/users', { name: f.name, email: f.email, role: f.role, departmentId, password: f.password });
      }
      this.userSheet().nativeElement.close();
      this.status.set(`Saved ${f.name}.`);
      await this.loadUsers();
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected openDept(d: Department | null) {
    this.formError.set('');
    this.editingDept.set(d);
    this.deptForm = d ? { name: d.name, code: d.code, sourceNote: d.sourceNote, active: d.active } : { name: '', code: '', sourceNote: '', active: true };
    this.deptSheet().nativeElement.showModal();
  }

  protected async saveDept() {
    this.busy.set(true);
    const f = this.deptForm;
    try {
      const editing = this.editingDept();
      if (editing) await this.api.patch(`/departments/${editing.id}`, { name: f.name, sourceNote: f.sourceNote, active: f.active });
      else await this.api.post('/departments', { name: f.name, code: f.code, sourceNote: f.sourceNote });
      this.deptSheet().nativeElement.close();
      this.status.set(`Saved ${f.name}.`);
      this.departments.set(await this.api.get<Department[]>('/departments'));
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected summary(e: AuditEntry) {
    const after = e.after as Record<string, unknown> | null;
    if (!after) return '';
    if (e.entity === 'transaction' && typeof after['amountPaise'] === 'number') return `Rs ${((after['amountPaise'] as number) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    if (e.entity === 'budget' && typeof after['allocatedPaise'] === 'number') return `Allocation Rs ${((after['allocatedPaise'] as number) / 1e9).toLocaleString('en-IN', { maximumFractionDigits: 2 })} crore`;
    if (typeof after['name'] === 'string') return after['name'] as string;
    if (typeof after['status'] === 'string') return `Now ${after['status']}`;
    return '';
  }
}
