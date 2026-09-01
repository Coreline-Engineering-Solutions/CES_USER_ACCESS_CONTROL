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

  // ─── Database switcher — ported from CES_MODULES' navbar ───────────────
  readonly showDbDropdown = signal(false);
  /** True while the auth API is being asked to flip the active DB. */
  readonly switchingDb = signal(false);
  /** db_gid currently being switched to (for a per-item spinner). */
  readonly switchingTo = signal<string>('');

  async ngOnInit(): Promise<void> {
    if (this.session.isValid()) {
      void this.session.fetchProfileImage();
    }
    await this.session.fetchDatabases();
    await this.session.fetchCurrentDb();
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

  // ─── Database switcher methods ──────────────────────────────────────────

  toggleDbDropdown(): void {
    this.showDbDropdown.update((v) => !v);
  }

  closeDbDropdown(): void {
    this.showDbDropdown.set(false);
  }

  async selectDb(db: any): Promise<void> {
    if (this.switchingDb()) return; // ignore double-clicks
    const dbGid = db.db_gid || db.global_id || db.gid;
    if (!dbGid) return;

    this.switchingDb.set(true);
    this.switchingTo.set(String(dbGid));
    try {
      // setCurrentDb polls the auth API until it confirms the new active DB.
      // If it returns false, do NOT reload — reloading before the backend
      // confirms loads the new page against the OLD DB context.
      const ok = await this.session.setCurrentDb(dbGid);
      if (!ok) {
        alert('Could not switch database — the server did not confirm the change. Try again, or refresh manually.');
        return;
      }
      this.closeDbDropdown();
      window.location.reload();
    } finally {
      this.switchingDb.set(false);
      this.switchingTo.set('');
    }
  }

  getDbName(db: any): string {
    return db?.name || db?.db_name || db?.description || 'Unknown DB';
  }

  getCurrentDbName(): string {
    const db = this.session.currentDb();
    if (!db) return 'Select Database';
    return db?.name || db?.db_name || db?.description || 'Current DB';
  }

  isCurrentDb(db: any): boolean {
    const current = this.session.currentDb();
    if (!current) return false;
    const currentGid = current.db_gid || current.global_id || current.gid;
    const dbGid = db.db_gid || db.global_id || db.gid;
    return currentGid === dbGid;
  }
}
