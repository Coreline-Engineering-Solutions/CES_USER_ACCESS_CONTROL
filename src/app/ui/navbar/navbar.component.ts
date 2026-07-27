import { Component, inject } from '@angular/core';
import { SessionService } from '../../session/session.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss',
})
export class NavbarComponent {
  readonly session = inject(SessionService);

  async signOut(): Promise<void> {
    await this.session.logout();
  }
}
