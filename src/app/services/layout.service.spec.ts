import { afterEach, describe, expect, it, vi } from 'vitest';

import { LayoutService, NARROW_QUERY } from './layout.service';

type Listener = (event: { matches: boolean }) => void;

/** A fake window.matchMedia we can flip between wide and narrow. */
function fakeScreen(narrow: boolean) {
  const listeners: Listener[] = [];
  const query = {
    matches: narrow,
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
  };
  const matchMedia = vi.fn((q: string) => {
    expect(q).toBe(NARROW_QUERY);
    return query;
  });
  vi.stubGlobal('window', { matchMedia });
  return {
    resize(toNarrow: boolean) {
      query.matches = toNarrow;
      listeners.forEach((l) => l({ matches: toNarrow }));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LayoutService', () => {
  it('on a wide screen the sidebar is a column that leaves 232px, or 64px when collapsed', () => {
    fakeScreen(false);
    const layout = new LayoutService();
    expect(layout.narrow()).toBe(false);
    expect(layout.sidebarWidth()).toBe(232);
    layout.toggleSidebar();
    expect(layout.sidebarWidth()).toBe(64);
    expect(layout.compact()).toBe(true);
  });

  it('on a narrow screen the sidebar is a drawer and the content keeps the whole width', () => {
    fakeScreen(true);
    const layout = new LayoutService();
    expect(layout.narrow()).toBe(true);
    expect(layout.sidebarWidth()).toBe(0);
  });

  it('a drawer always shows its labels, even if the sidebar was collapsed on a wide screen', () => {
    fakeScreen(true);
    const layout = new LayoutService();
    layout.collapseSidebar();
    expect(layout.sidebarCollapsed()).toBe(true);
    expect(layout.compact()).toBe(false);
  });

  it('the drawer opens, closes and toggles', () => {
    fakeScreen(true);
    const layout = new LayoutService();
    expect(layout.drawerOpen()).toBe(false);
    layout.openDrawer();
    expect(layout.drawerOpen()).toBe(true);
    layout.closeDrawer();
    expect(layout.drawerOpen()).toBe(false);
    layout.toggleDrawer();
    expect(layout.drawerOpen()).toBe(true);
  });

  it('widening the window closes an open drawer and brings the sidebar column back', () => {
    const screen = fakeScreen(true);
    const layout = new LayoutService();
    layout.openDrawer();
    screen.resize(false);
    expect(layout.narrow()).toBe(false);
    expect(layout.drawerOpen()).toBe(false);
    expect(layout.sidebarWidth()).toBe(232);
  });

  it('narrowing the window turns the sidebar into a drawer', () => {
    const screen = fakeScreen(false);
    const layout = new LayoutService();
    screen.resize(true);
    expect(layout.narrow()).toBe(true);
    expect(layout.sidebarWidth()).toBe(0);
  });

  it('works where there is no matchMedia (it just stays wide)', () => {
    vi.stubGlobal('window', {});
    const layout = new LayoutService();
    expect(layout.narrow()).toBe(false);
    expect(layout.sidebarWidth()).toBe(232);
  });
});
