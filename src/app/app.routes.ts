import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'signed-out',
    loadComponent: () => import('./pages/signed-out/signed-out.component').then((m) => m.SignedOutComponent),
  },
  { path: '**', redirectTo: '' },
];
