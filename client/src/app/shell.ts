import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Api } from './api';
import { Auth, ROLE_LABELS, Role } from './auth';
import { BrandMark, Icon } from './ui';

const ALERT_POLL_MS = 60_000;
const NAV: { path: string; label: string; icon: string; roles: Role[] }[] = [
  { path: '/', label: 'Overview', icon: 'overview', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/alerts', label: 'Alerts', icon: 'alerts', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/expenditure', label: 'Expenditure', icon: 'expenditure', roles: ['finance_officer', 'department_head'] },
  { path: '/budgets', label: 'Budgets', icon: 'budgets', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/reports', label: 'Reports', icon: 'reports', roles: ['admin', 'finance_officer', 'department_head'] },
  { path: '/admin', label: 'Administration', icon: 'admin', roles: ['admin'] },
  { path: '/admin', label: 'Audit log', icon: 'audit', roles: ['finance_officer'] },
];

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Icon, BrandMark],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" routerLink="/">
          <app-mark />
          <span><span class="brand-name">Budget Monitor</span><span class="brand-sub">Union Government accounts</span></span>
        </a>
        <nav class="nav" aria-label="Main">
          @for (item of nav(); track item.label) {
            <a [routerLink]="item.path" routerLinkActive="current" [routerLinkActiveOptions]="{ exact: item.path === '/' }" ariaCurrentWhenActive="page">
              <app-icon [name]="item.icon" />
              <span>{{ item.label }}</span>
              @if (item.path === '/alerts' && openAlerts()) {
                <span class="count" [attr.aria-label]="openAlerts() + ' open'">{{ openAlerts() }}</span>
              }
            </a>
          }
        </nav>
        <div class="sidebar-foot">
          <p><span class="strong">{{ auth.user()?.name }}</span><br /><span class="muted">{{ role() }}</span></p>
          <button type="button" class="link" (click)="signOut()">Sign out</button>
        </div>
      </aside>
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
