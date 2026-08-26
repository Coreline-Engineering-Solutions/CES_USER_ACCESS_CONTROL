import { Component, OnInit, inject, signal } from '@angular/core';
import { SessionService } from '../../session/session.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss',
})
export class NavbarComponent implements OnInit {
  readonly session = inject(SessionService);

  readonly showProfileMenu = signal(false);

  ngOnInit(): void {
    if (this.session.isValid()) {
      void this.session.fetchProfileImage();
    }
  }

  toggleProfileMenu(): void {
    this.showProfileMenu.update((v) => !v);
  }

  closeProfileMenu(): void {
    this.showProfileMenu.set(false);
  }

  get userInitial(): string {
    return this.session.getInitials();
  }

  async signOut(): Promise<void> {
    await this.session.logout();
  }
}
