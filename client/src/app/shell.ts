import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth, ROLE_LABELS } from './auth';

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="shell">
      <nav class="rail" aria-label="Main">
        <p class="rail-title">Budget Monitor</p>
        <a routerLink="/" routerLinkActive="current" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Overview</a>
        <div class="rail-foot">
          <p>{{ auth.user()?.name }}<br /><span class="muted">{{ role() }}</span></p>
          <button type="button" class="link" (click)="signOut()">Sign out</button>
        </div>
      </nav>
      <main class="page"><router-outlet /></main>
    </div>
  `,
})
export class Shell {
  protected auth = inject(Auth);
  private router = inject(Router);
  protected role = computed(() => {
    const user = this.auth.user();
    return user ? ROLE_LABELS[user.role] : '';
  });

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
