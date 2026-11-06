import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Auth } from './auth';
import { yearPositionToday } from './format';
import { BrandMark, PaceRings } from './ui';

@Component({
  selector: 'app-login',
  imports: [FormsModule, BrandMark, PaceRings],
  template: `
    <div class="signin">
      <section class="signin-story">
        <div class="brand">
          <app-mark />
          <span><span class="brand-name">Budget Monitor</span><span class="brand-sub">Union Government accounts</span></span>
        </div>
        <div>
          <h1>Know where every rupee stands while the year still has time to run.</h1>
          <p>Allocation, spending and the pace between them for every budget head, built on the Controller General of Accounts' monthly figures.</p>
        </div>
        <div class="signin-year" style="--track: rgb(255 255 255 / 0.16); --time: #ffffff; --ink: #ffffff; --secondary: rgb(255 255 255 / 0.72)">
          <app-rings [single]="true" [elapsed]="year.pct" [size]="112" [centre]="'' + year.day" [centreSub]="'of ' + year.days" />
          <p>Day {{ year.day }} of financial year {{ year.financialYear }}.<br />{{ year.pct.toFixed(2) }}% of the year has passed.</p>
        </div>
      </section>

      <main class="signin-form">
        <form (ngSubmit)="submit()">
          <h2>Sign in</h2>
          <p class="muted" style="margin-bottom: 24px">Use the account your administrator created for you.</p>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required [(ngModel)]="email" />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required [(ngModel)]="password" />
          </div>
          <p class="form-error" role="alert">{{ error() }}</p>
          <button type="submit" [disabled]="busy()">{{ busy() ? 'Signing in' : 'Sign in' }}</button>
        </form>
      </main>
    </div>
  `,
})
export class Login {
  private auth = inject(Auth);
  private router = inject(Router);
  protected email = signal('');
  protected password = signal('');
  protected error = signal('');
  protected busy = signal(false);
  protected year = yearPositionToday();

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.signIn(this.email(), this.password());
      await this.router.navigateByUrl('/');
    } catch (err) {
      const { status, error } = err as HttpErrorResponse;
      this.error.set(status === 400 ? 'Enter a valid email and password.' : (error?.error ?? 'Could not reach the server. Check the connection and try again.'));
      this.password.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
