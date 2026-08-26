import { Injectable, computed, signal } from '@angular/core';

/**
 * Sidebar open/closed state, shared across the app so the main content area
 * can shift its left padding to match. Mirrors CES_STOCK_MANAGER's (and
 * CES_MODULES') LayoutService so all three apps behave the same way.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _sidebarCollapsed = signal(false);

  readonly sidebarCollapsed = this._sidebarCollapsed.asReadonly();
  readonly sidebarWidth = computed(() => (this._sidebarCollapsed() ? 64 : 232));

  toggleSidebar(): void {
    this._sidebarCollapsed.update((v) => !v);
  }

  collapseSidebar(): void {
    this._sidebarCollapsed.set(true);
  }

  expandSidebar(): void {
    this._sidebarCollapsed.set(false);
  }
}
