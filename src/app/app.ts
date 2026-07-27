import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionService } from './session/session.service';
import { NavbarComponent } from './ui/navbar/navbar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly session = inject(SessionService);

  ngOnInit(): void {
    void this.session.validate(null);
  }
}
