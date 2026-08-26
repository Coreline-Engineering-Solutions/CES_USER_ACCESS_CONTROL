import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { inject } from '@angular/core';
import { LayoutService } from '../../services/layout.service';

/**
 * Left nav rail — mirrors CES_STOCK_MANAGER's sidebar (which itself mirrors
 * CES_MODULES') so the CES family reads as one product, not four different
 * shells. UAC only has two real routes today (Dashboard, Access control),
 * both leaves — no collapsible groups needed yet, unlike Stock Manager's
 * Inventory/Movements/Records sections. Add a group the same way Stock
 * Manager does if a third top-level area shows up later.
 */
interface NavItem {
  label: string;
  route: string;
  icon: 'dashboard' | 'access';
}

const ITEMS: NavItem[] = [
  { label: 'Dashboard', route: '/', icon: 'dashboard' },
  { label: 'Access control', route: '/access', icon: 'access' },
];

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  readonly layout = inject(LayoutService);
  readonly items = ITEMS;
}
