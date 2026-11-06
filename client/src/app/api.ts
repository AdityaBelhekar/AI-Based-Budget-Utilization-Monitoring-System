import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

type Params = Record<string, string | number | boolean | null | undefined>;

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  private params(params: Params = {}) {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
    return p;
  }

  get<T>(url: string, params?: Params) {
    return firstValueFrom(this.http.get<T>(`/api${url}`, { params: this.params(params) }));
  }
  post<T>(url: string, body: unknown = {}) {
    return firstValueFrom(this.http.post<T>(`/api${url}`, body));
  }
  postText<T>(url: string, text: string) {
    return firstValueFrom(this.http.post<T>(`/api${url}`, text, { headers: { 'Content-Type': 'text/csv' } }));
  }
  postFile<T>(url: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return firstValueFrom(this.http.post<T>(`/api${url}`, form));
  }
  patch<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.patch<T>(`/api${url}`, body));
  }
  put<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.put<T>(`/api${url}`, body));
  }
  delete(url: string) {
    return firstValueFrom(this.http.delete(`/api${url}`));
  }
  url(path: string, params?: Params) {
    const query = this.params(params).toString();
    return `/api${path}${query ? `?${query}` : ''}`;
  }
}

// Turns a failed request into a sentence that says what to do.
export function errorText(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return 'Something went wrong. Try again.';
  if (err.status === 0) return 'Could not reach the server. Check the connection and try again.';
  const body = err.error ?? {};
  if (body.issues?.length) return body.issues.map((i: { path: string[]; message: string }) => `${i.path.join('.') || 'Input'}: ${i.message}`).join('. ');
  return body.error ?? `The request failed (${err.status}).`;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface MonthState {
  month: string;
  available: boolean;
  published: boolean;
}

export interface View {
  financialYear: string;
  month: string;
  asOf: string;
  publishedThrough: string | null;
  months: MonthState[];
  dayOfYear: number;
  daysInYear: number;
  elapsedPct: number;
}

export interface PositionRow {
  budgetId: string;
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  sourceNote: string;
  sourceUrl: string;
  allocatedPaise: number;
  spentPaise: number;
  remainingPaise: number;
  utilizationPct: number;
  elapsedPct: number;
  gapPts: number;
  gapPaise: number;
  paceLimitPts: number;
  status: 'behind' | 'ahead' | 'on' | 'over';
  openAlerts: number;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  sourceNote: string;
  active: boolean;
}

export interface Budget {
  id: string;
  financialYear: string;
  departmentId: string;
  project: string;
  allocatedPaise: number;
  spentPaise: number;
  remainingPaise: number;
  utilizationPct: number;
  quarterSplit?: number[];
  sourceUrl: string;
  revisions: { date: string; allocatedPaise: number; reason: string }[];
}

export interface Transaction {
  id: string;
  kind: 'expense' | 'reversal' | 'monthly_summary';
  budgetId: string;
  departmentId: string;
  financialYear: string;
  amountPaise: number;
  category: string;
  date: string;
  description: string;
  payee: string;
  sourceUrl: string;
  reversesId?: string;
  reason: string;
  createdAt: string;
}

export interface Alert {
  id: string;
  budgetId: string;
  departmentId: { id: string; name: string; code: string };
  financialYear: string;
  type: string;
  periodKey: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  message: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
  history: { at: string; action: string; severity?: string; actorName?: string; note?: string }[];
}

export interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string;
  at: string;
}
