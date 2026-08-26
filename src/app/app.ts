import { Component, OnInit, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionService } from './session/session.service';
import { NavbarComponent } from './ui/navbar/navbar.component';
import { SidebarComponent } from './ui/sidebar/sidebar.component';
import { LayoutService } from './services/layout.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent, SidebarComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly session = inject(SessionService);
  readonly layout = inject(LayoutService);

  readonly mainOffsetPx = computed(() => (this.session.session() ? this.layout.sidebarWidth() : 0));

  ngOnInit(): void {
    void this.session.validate(null);
  }
}
