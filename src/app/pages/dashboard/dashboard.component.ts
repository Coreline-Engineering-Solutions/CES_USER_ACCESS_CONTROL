import { Component, inject } from '@angular/core';
import { SessionService } from '../../session/session.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  readonly session = inject(SessionService);
}
