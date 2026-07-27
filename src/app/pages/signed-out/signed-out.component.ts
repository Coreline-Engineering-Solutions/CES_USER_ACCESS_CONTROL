import { Component, inject } from '@angular/core';
import { SessionService } from '../../session/session.service';

@Component({
  selector: 'app-signed-out',
  standalone: true,
  templateUrl: './signed-out.component.html',
  styleUrl: './signed-out.component.scss',
})
export class SignedOutComponent {
  private readonly session = inject(SessionService);

  get loading(): boolean {
    return this.session.loading();
  }

  signIn(): void {
    window.location.href = 'https://www.corelineengineering.com/Login';
  }
}
