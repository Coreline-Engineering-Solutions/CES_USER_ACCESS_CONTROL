import { Injectable, computed, signal } from '@angular/core';

/** At or below this width the sidebar is a slide-in drawer, not a fixed column. */
export const NARROW_QUERY = '(max-width: 900px)';

/**
 * Sidebar state, shared across the app so the main content area can leave
 * the right amount of room. Mirrors CES_STOCK_MANAGER's (and CES_MODULES')
 * LayoutService so every CES app behaves the same way here.
 *
 * On a wide screen the sidebar is a fixed column that can be collapsed to
 * icons. On a tablet or phone it becomes a drawer: hidden until the menu
 * button opens it, over the page, so the content keeps the whole width.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _sidebarCollapsed = signal(false);
  private readonly _narrow = signal(false);
  private readonly _drawerOpen = signal(false);

  readonly sidebarCollapsed = this._sidebarCollapsed.asReadonly();
  /** True on a tablet or phone width. */
  readonly narrow = this._narrow.asReadonly();
  readonly drawerOpen = this._drawerOpen.asReadonly();
  /** Icon-only sidebar: wide screens only. A drawer always shows its labels. */
  readonly compact = computed(() => this._sidebarCollapsed() && !this._narrow());
  /** Room the content leaves on the left: none when the sidebar is a drawer. */
  readonly sidebarWidth = computed(() => (this._narrow() ? 0 : this._sidebarCollapsed() ? 64 : 232));

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    this._narrow.set(query.matches);
    query.addEventListener?.('change', (event) => {
      this._narrow.set(event.matches);
      if (!event.matches) this._drawerOpen.set(false);
    });
  }

  toggleSidebar(): void {
    this._sidebarCollapsed.update((v) => !v);
  }

  collapseSidebar(): void {
    this._sidebarCollapsed.set(true);
  }

  expandSidebar(): void {
    this._sidebarCollapsed.set(false);
  }

  openDrawer(): void {
    this._drawerOpen.set(true);
  }

  closeDrawer(): void {
    this._drawerOpen.set(false);
  }

  toggleDrawer(): void {
    this._drawerOpen.update((v) => !v);
  }
}
