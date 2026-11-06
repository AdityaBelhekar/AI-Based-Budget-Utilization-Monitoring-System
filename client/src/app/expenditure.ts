import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, Budget, Department, errorText, Paged, Transaction } from './api';
import { Auth } from './auth';
import { CATEGORIES, currentFinancialYear, day, money, parseRupees, pct, rupees } from './format';
import { YearPicker } from './ui';

const KINDS: Record<string, string> = { expense: 'Expense', reversal: 'Reversal', monthly_summary: 'Published month' };
const PAGE_SIZE = 50;

interface Doc {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
}

@Component({
  selector: 'app-expenditure',
  imports: [FormsModule, YearPicker],
  template: `
    <div class="page-head">
      <div>
        <h1>Expenditure</h1>
        <p class="muted" style="margin: 0">Every record is kept. A mistake is corrected by reversing it, never by editing.</p>
      </div>
      <div class="toolbar">
        <button type="button" (click)="openEntry()">Record expense</button>
        <button type="button" class="secondary" (click)="importSheet.showModal()">Import CSV</button>
      </div>
    </div>
    <p class="status-line" role="status">{{ status() }}</p>

    <div class="toolbar" style="margin-bottom: 12px">
      <app-year [value]="fy()" (pick)="setQuery({ fy: $event, budgetId: null, page: null })" />
      @if (departments().length > 1) {
        <div class="field-inline">
          <label for="f-dept">Budget head</label>
          <select id="f-dept" (change)="setQuery({ departmentId: $any($event.target).value || null, budgetId: null, page: null })">
            <option value="">All</option>
            @for (dpt of departments(); track dpt.id) {
              <option [value]="dpt.id" [selected]="dpt.id === q('departmentId')">{{ dpt.name }}</option>
            }
          </select>
        </div>
      }
      <div class="field-inline">
        <label for="f-kind">Type</label>
        <select id="f-kind" (change)="setQuery({ kind: $any($event.target).value || null, page: null })">
          <option value="">All</option>
          @for (k of kindKeys; track k) {
            <option [value]="k" [selected]="k === q('kind')">{{ kinds[k] }}</option>
          }
        </select>
      </div>
      <div class="field-inline">
        <label for="f-cat">Category</label>
        <select id="f-cat" (change)="setQuery({ category: $any($event.target).value || null, page: null })">
          <option value="">All</option>
          @for (c of categories; track c) {
            <option [value]="c" [selected]="c === q('category')">{{ c }}</option>
          }
        </select>
      </div>
      <div class="field-inline">
        <label for="f-from">From</label>
        <input id="f-from" type="date" [value]="q('from')" (change)="setQuery({ from: $any($event.target).value || null, page: null })" />
      </div>
      <div class="field-inline">
        <label for="f-to">To</label>
        <input id="f-to" type="date" [value]="q('to')" (change)="setQuery({ to: $any($event.target).value || null, page: null })" />
      </div>
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <section class="panel panel-flush">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Budget head</th>
            <th class="hide-compact">Category</th>
            <th>Description</th>
            <th class="num">Amount, Rs</th>
            <th><span class="visually-hidden">Details</span></th>
          </tr>
        </thead>
        <tbody>
          @for (t of page()?.items ?? []; track t.id) {
            <tr>
              <td class="nowrap">{{ day(t.date.slice(0, 10)) }}</td>
              <td>{{ budgetLabel(t) }}<span class="sub">{{ kinds[t.kind] }}</span></td>
              <td class="hide-compact">{{ t.category }}</td>
              <td>{{ t.description }}@if (t.payee) {<span class="sub">{{ t.payee }}</span>}</td>
              <td class="num" [class.muted]="t.amountPaise < 0">{{ rupees(t.amountPaise) }}</td>
              <td class="num"><button type="button" class="link" (click)="openDetail(t)">Details</button></td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="empty">No records match these filters. Record an expense, or widen the filters.</td></tr>
          }
        </tbody>
      </table>
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

    <dialog class="sheet" #entrySheet aria-labelledby="entry-title">
      <h2 id="entry-title">Record expense</h2>
      <form (ngSubmit)="record()">
        <div class="field">
          <label for="e-budget">Budget</label>
          <select id="e-budget" name="budget" [(ngModel)]="entry.budgetId" required>
            @for (b of currentBudgets(); track b.id) {
              <option [value]="b.id">{{ budgetName(b) }}, {{ pct(b.utilizationPct) }} used</option>
            }
          </select>
          @if (!currentBudgets().length) {
            <p class="hint error">There is no budget for {{ thisYear }} to spend from. An Admin creates budgets.</p>
          }
        </div>
        <div class="field">
          <label for="e-date">Date</label>
          <input id="e-date" name="date" type="date" [(ngModel)]="entry.date" [max]="today" required />
        </div>
        <div class="field">
          <label for="e-amount">Amount, Rs</label>
          <input id="e-amount" name="amount" inputmode="decimal" [(ngModel)]="entry.amount" required autocomplete="off" />
          @if (entry.amount && parse(entry.amount) === null) {
            <p class="hint error">Enter rupees, with up to two decimal places.</p>
          }
        </div>
        <div class="field">
          <label for="e-cat">Category</label>
          <select id="e-cat" name="category" [(ngModel)]="entry.category" required>
            @for (c of categories; track c) {
              <option [value]="c">{{ c }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="e-desc">Description</label>
          <input id="e-desc" name="description" [(ngModel)]="entry.description" maxlength="500" />
        </div>
        <div class="field">
          <label for="e-payee">Payee</label>
          <input id="e-payee" name="payee" [(ngModel)]="entry.payee" maxlength="200" />
        </div>
        <p class="form-error" role="alert">{{ formError() }}</p>
        <div class="sheet-actions">
          <button type="submit" [disabled]="busy() || !currentBudgets().length">Save expense</button>
          <button type="button" class="secondary" (click)="entrySheet.close()">Cancel</button>
        </div>
      </form>
    </dialog>

    <dialog class="sheet" #importSheet aria-labelledby="import-title">
      <h2 id="import-title">Import expenses from CSV</h2>
      <p>The file needs these columns: <code>budget_id, date, amount_rupees, category, description, payee</code>. If any row has a problem, nothing is imported.</p>
      <div class="field">
        <label for="i-file">CSV file</label>
        <input id="i-file" type="file" accept=".csv,text/csv" (change)="importFile($event)" />
      </div>
      <p class="form-error" role="alert">{{ importError() }}</p>
      @if (importRows().length) {
        <ul class="small">
          @for (r of importRows(); track r.row) {
            <li>Row {{ r.row }}: {{ r.message }}</li>
          }
        </ul>
      }
      <h3>Budget IDs for {{ thisYear }}</h3>
      <ul class="small" style="padding-left: 18px">
        @for (b of currentBudgets(); track b.id) {
          <li>{{ budgetName(b) }}: <code>{{ b.id }}</code></li>
        }
      </ul>
      <button type="button" class="secondary" (click)="importSheet.close()">Close</button>
    </dialog>

    <dialog class="sheet" #detailSheet aria-labelledby="detail-title">
      @if (selected(); as t) {
        <h2 id="detail-title">{{ kinds[t.kind] }} of {{ money(t.amountPaise) }}</h2>
        <dl class="figures" style="flex-direction: column; gap: 8px">
          <div><dt>Budget head</dt><dd>{{ budgetLabel(t) }}</dd></div>
          <div><dt>Date</dt><dd>{{ day(t.date.slice(0, 10)) }}</dd></div>
          <div><dt>Category</dt><dd>{{ t.category }}</dd></div>
          @if (t.description) {<div><dt>Description</dt><dd>{{ t.description }}</dd></div>}
          @if (t.payee) {<div><dt>Payee</dt><dd>{{ t.payee }}</dd></div>}
          @if (t.reason) {<div><dt>Reason</dt><dd>{{ t.reason }}</dd></div>}
          @if (t.sourceUrl) {<div><dt>Source</dt><dd><a [href]="t.sourceUrl" target="_blank" rel="noopener">CGA monthly accounts</a></dd></div>}
        </dl>

        @if (t.kind === 'expense') {
          <h3>Supporting documents</h3>
          @for (doc of docs(); track doc.id) {
            <p style="margin-bottom: 4px"><a [href]="'/api/documents/' + doc.id">{{ doc.name }}</a> <span class="muted small">{{ (doc.size / 1024).toFixed(0) }} KB</span></p>
          } @empty {
            <p class="muted">None attached.</p>
          }
          <div class="field">
            <label for="d-file">Attach a PDF, JPG or PNG, up to 4 MB</label>
            <input id="d-file" type="file" accept=".pdf,.jpg,.jpeg,.png" (change)="attach(t, $event)" />
          </div>
          @if (isFinance) {
            <h3 style="margin-top: 20px">Reverse this expense</h3>
            <p class="small muted">Adds a matching negative record. The original stays in the ledger.</p>
            <form (ngSubmit)="reverse(t)">
              <div class="field">
                <label for="r-reason">Reason</label>
                <textarea id="r-reason" name="reason" [(ngModel)]="reverseReason" required minlength="3"></textarea>
              </div>
              <button type="submit" class="secondary" [disabled]="busy()">Reverse expense</button>
            </form>
          }
        }
        <p class="form-error" role="alert" style="margin-top: 12px">{{ formError() }}</p>
        <button type="button" class="secondary" (click)="detailSheet.close()">Close</button>
      }
    </dialog>
  `,
})
export class Expenditure {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private query = toSignal(this.route.queryParamMap);
  protected isFinance = inject(Auth).can('finance_officer');
  protected entrySheet = viewChild.required<ElementRef<HTMLDialogElement>>('entrySheet');
  protected importSheet = viewChild.required<ElementRef<HTMLDialogElement>>('importSheet');
  protected detailSheet = viewChild.required<ElementRef<HTMLDialogElement>>('detailSheet');

  protected page = signal<Paged<Transaction> | null>(null);
  protected departments = signal<Department[]>([]);
  protected budgets = signal<Budget[]>([]);
  protected selected = signal<Transaction | null>(null);
  protected docs = signal<Doc[]>([]);
  protected status = signal('');
  protected error = signal('');
  protected formError = signal('');
  protected importError = signal('');
  protected importRows = signal<{ row: number; message: string }[]>([]);
  protected busy = signal(false);
  protected reverseReason = '';

  protected kinds = KINDS;
  protected kindKeys = Object.keys(KINDS);
  protected categories = CATEGORIES;
  protected thisYear = currentFinancialYear();
  protected today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  protected entry = this.blankEntry();
  protected Math = Math;
  protected day = day;
  protected money = money;
  protected rupees = rupees;
  protected pct = pct;
  protected parse = parseRupees;

  protected fy = computed(() => this.query()?.get('fy') ?? currentFinancialYear());
  protected q = (key: string) => this.query()?.get(key) ?? '';
  protected currentBudgets = computed(() => this.budgets().filter((b) => b.financialYear === this.thisYear));

  constructor() {
    this.api.get<Department[]>('/departments').then((d) => this.departments.set(d)).catch((e) => this.error.set(errorText(e)));
    this.loadBudgets();
    effect(() => {
      if (this.query()) this.load();
    });
  }

  private async loadBudgets() {
    const res = await this.api.get<Paged<Budget>>('/budgets', { limit: 200, financialYear: this.thisYear }).catch(() => null);
    const all = await this.api.get<Paged<Budget>>('/budgets', { limit: 200, financialYear: this.fy() }).catch(() => null);
    const byId = new Map([...(res?.items ?? []), ...(all?.items ?? [])].map((b) => [b.id, b]));
    this.budgets.set([...byId.values()]);
  }

  private async load() {
    this.error.set('');
    try {
      this.page.set(
        await this.api.get<Paged<Transaction>>('/transactions', {
          financialYear: this.fy(),
          departmentId: this.q('departmentId'),
          budgetId: this.q('budgetId'),
          kind: this.q('kind'),
          category: this.q('category'),
          from: this.q('from'),
          to: this.q('to'),
          page: this.q('page') || 1,
          limit: PAGE_SIZE,
        }),
      );
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  protected setQuery(change: Record<string, string | number | null>) {
    this.router.navigate([], { queryParams: change, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected budgetName = (b: Budget) => `${this.departments().find((d) => d.id === b.departmentId)?.name ?? ''}${b.project ? `, ${b.project}` : ''}`;
  protected budgetLabel = (t: Transaction) => {
    const b = this.budgets().find((x) => x.id === t.budgetId);
    return b ? this.budgetName(b) : (this.departments().find((d) => d.id === t.departmentId)?.name ?? '');
  };

  private blankEntry() {
    return { budgetId: '', date: '', amount: '', category: 'Equipment', description: '', payee: '' };
  }

  protected openEntry() {
    this.formError.set('');
    this.entry = { ...this.blankEntry(), budgetId: this.currentBudgets()[0]?.id ?? '', date: this.today };
    this.entrySheet().nativeElement.showModal();
  }

  protected async record() {
    const amountPaise = parseRupees(this.entry.amount);
    if (amountPaise === null || amountPaise <= 0) return this.formError.set('Enter an amount in rupees greater than zero.');
    this.busy.set(true);
    try {
      const { amount: _, ...fields } = this.entry;
      await this.api.post('/transactions', { ...fields, amountPaise });
      const budget = await this.api.get<Budget>(`/budgets/${this.entry.budgetId}`);
      this.entrySheet().nativeElement.close();
      this.status.set(`Saved. ${this.budgetName(budget)} is now ${pct(budget.utilizationPct)} used.`);
      await Promise.all([this.load(), this.loadBudgets()]);
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async importFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.importError.set('');
    this.importRows.set([]);
    try {
      const res = await this.api.postText<{ imported: number }>('/transactions/import', await file.text());
      this.importSheet().nativeElement.close();
      this.status.set(`Imported ${res.imported} expenses from ${file.name}.`);
      await Promise.all([this.load(), this.loadBudgets()]);
    } catch (err) {
      this.importError.set(errorText(err));
      const rows = (err as { error?: { rows?: { row: number; message: string }[] } }).error?.rows;
      this.importRows.set(rows ?? []);
    } finally {
      (event.target as HTMLInputElement).value = '';
    }
  }

  protected async openDetail(t: Transaction) {
    this.selected.set(t);
    this.formError.set('');
    this.reverseReason = '';
    this.docs.set([]);
    this.detailSheet().nativeElement.showModal();
    if (t.kind === 'expense') this.docs.set(await this.api.get<Doc[]>(`/transactions/${t.id}/documents`).catch(() => []));
  }

  protected async attach(t: Transaction, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.formError.set('');
    try {
      await this.api.postFile(`/transactions/${t.id}/documents`, file);
      this.docs.set(await this.api.get<Doc[]>(`/transactions/${t.id}/documents`));
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      input.value = '';
    }
  }

  protected async reverse(t: Transaction) {
    this.busy.set(true);
    try {
      await this.api.post(`/transactions/${t.id}/reverse`, { reason: this.reverseReason });
      this.detailSheet().nativeElement.close();
      this.status.set(`Reversed the ${money(t.amountPaise)} expense of ${day(t.date.slice(0, 10))}.`);
      await Promise.all([this.load(), this.loadBudgets()]);
    } catch (err) {
      this.formError.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }
}
