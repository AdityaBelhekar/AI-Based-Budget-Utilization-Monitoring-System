import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, firstValueFrom, of, tap } from 'rxjs';

export type Role = 'admin' | 'finance_officer' | 'department_head';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
  active?: boolean;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  finance_officer: 'Finance Officer',
  department_head: 'Department Head',
};

@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  readonly user = signal<User | null>(null);
  private checked = false;

  can(...roles: Role[]) {
    const role = this.user()?.role;
    return role ? roles.includes(role) : false;
  }

  async restore(): Promise<User | null> {
    if (!this.checked) {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me').pipe(catchError(() => of(null))));
      this.user.set(user);
      this.checked = true;
    }
    return this.user();
  }

  async signIn(email: string, password: string) {
    this.user.set(await firstValueFrom(this.http.post<User>('/api/auth/login', { email, password })));
    this.checked = true;
  }

  async signOut() {
    await firstValueFrom(this.http.post('/api/auth/logout', {}));
    this.user.set(null);
  }
}

export const signedIn: CanActivateFn = async () => {
  // inject() only works before the first await.
  const auth = inject(Auth);
  const router = inject(Router);
  return (await auth.restore()) ? true : router.parseUrl('/login');
};

// A session can end while the app is open: it expires, or an Admin deactivates the user.
export const sessionExpired: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  return next(req).pipe(
    tap({
      error: (err: HttpErrorResponse) => {
        if (err.status === 401 && !req.url.startsWith('/api/auth/') && auth.user()) {
          auth.user.set(null);
          router.navigateByUrl('/login');
        }
      },
    }),
  );
};
