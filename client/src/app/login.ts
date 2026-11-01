import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Auth } from './auth';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <main class="login">
      <h1>Budget Utilization Monitor</h1>
      <p class="muted">Tracks allocation against spending, department by department, and flags what is off pace.</p>

      <form (ngSubmit)="submit()">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required [(ngModel)]="email" />

        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required [(ngModel)]="password" />

        <p class="error" role="alert">{{ error() }}</p>
        <button type="submit" [disabled]="busy()">{{ busy() ? 'Signing in' : 'Sign in' }}</button>
      </form>
    </main>
  `,
})
export class Login {
  private auth = inject(Auth);
  private router = inject(Router);
  protected email = signal('');
  protected password = signal('');
  protected error = signal('');
  protected busy = signal(false);

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.signIn(this.email(), this.password());
      await this.router.navigateByUrl('/');
    } catch (err) {
      const { status, error } = err as HttpErrorResponse;
      this.error.set(status === 400 ? 'Enter a valid email and password.' : (error?.error ?? 'Could not reach the server. Try again.'));
      this.password.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
