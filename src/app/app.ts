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
    // Gate the app on the caller actually holding this utility.
    //
    // validate() has always supported a required tool and always applied it
    // (no tool -> session is cleared -> authGuard bounces to /signed-out), but
    // it was being called with null, so the check never ran. Any user with a
    // valid session could open User Access Control regardless of whether it
    // had been granted to them. The machinery was right; the argument wasn't.
    void this.session.validate('User Access Control');
  }
}
