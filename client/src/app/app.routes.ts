import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { Admin } from './admin';
import { Alerts } from './alerts';
import { Auth, Role, signedIn } from './auth';
import { Budgets } from './budgets';
import { DepartmentPage } from './department';
import { Expenditure } from './expenditure';
import { Login } from './login';
import { Overview } from './overview';
import { Reports } from './reports';
import { Shell } from './shell';

// For convenience only: the server enforces every role on every route.
const roles =
  (...allowed: Role[]): CanActivateFn =>
  () =>
    inject(Auth).can(...allowed) || inject(Router).parseUrl('/');

const title = (page: string) => `${page} | Budget Utilization Monitor`;

export const routes: Routes = [
  { path: 'login', component: Login, title: title('Sign in') },
  {
    path: '',
    component: Shell,
    canActivate: [signedIn],
    children: [
      { path: '', component: Overview, title: title('Overview') },
      { path: 'departments/:id', component: DepartmentPage, title: title('Department') },
      { path: 'alerts', component: Alerts, title: title('Alerts') },
      { path: 'expenditure', component: Expenditure, canActivate: [roles('finance_officer', 'department_head')], title: title('Expenditure') },
      { path: 'budgets', component: Budgets, title: title('Budgets') },
      { path: 'reports', component: Reports, title: title('Reports') },
      { path: 'admin', component: Admin, canActivate: [roles('admin', 'finance_officer')], title: title('Administration') },
    ],
  },
  { path: '**', redirectTo: '' },
];
