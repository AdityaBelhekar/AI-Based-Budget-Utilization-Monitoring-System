import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Api } from './api';
import { Auth, ROLE_LABELS, Role } from './auth';

const ALERT_POLL_MS = 60_000;
const NAV: { path: string; label: string; roles: Role[] }[] = [
  { path: '/', label: 'Overview', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/alerts', label: 'Alerts', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/expenditure', label: 'Expenditure', roles: ['finance_officer', 'department_head'] },
  { path: '/budgets', label: 'Budgets', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/reports', label: 'Reports', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/admin', label: 'Administration', roles: ['admin'] },
  { path: '/admin', label: 'Audit log', roles: ['finance_officer'] },
];

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="shell">
      <nav class="rail" aria-label="Main">
        <p class="rail-title">Budget Monitor</p>
        <nav>
          @for (item of nav(); track item.label) {
            <a [routerLink]="item.path" routerLinkActive="current" [routerLinkActiveOptions]="{ exact: item.path === '/' }" ariaCurrentWhenActive="page">
              <span>{{ item.label }}</span>
              @if (item.path === '/alerts' && openAlerts()) {
                <span class="strong" [attr.aria-label]="openAlerts() + ' open'">{{ openAlerts() }}</span>
              }
            </a>
          }
        </nav>
        <div class="rail-foot">
          <p style="margin-bottom: 6px">{{ auth.user()?.name }}<br /><span class="muted">{{ role() }}</span></p>
          <button type="button" class="link" (click)="signOut()">Sign out</button>
        </div>
      </nav>
      <main class="page"><router-outlet /></main>
    </div>
  `,
})
export class Shell {
  protected auth = inject(Auth);
  private api = inject(Api);
  private router = inject(Router);
  protected openAlerts = signal(0);
  protected role = computed(() => {
    const user = this.auth.user();
    return user ? ROLE_LABELS[user.role] : '';
  });
  protected nav = computed(() => NAV.filter((n) => this.auth.can(...n.roles)));

  constructor() {
    const refresh = () => this.api.get<{ open: number }>('/alerts/unread-count').then((r) => this.openAlerts.set(r.open)).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, ALERT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
