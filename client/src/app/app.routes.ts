import { Routes } from '@angular/router';
import { signedIn } from './auth';
import { Login } from './login';
import { Overview } from './overview';
import { Shell } from './shell';

export const routes: Routes = [
  { path: 'login', component: Login, title: 'Sign in | Budget Utilization Monitor' },
  {
    path: '',
    component: Shell,
    canActivate: [signedIn],
    children: [{ path: '', component: Overview, title: 'Overview | Budget Utilization Monitor' }],
  },
  { path: '**', redirectTo: '' },
];
