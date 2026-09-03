import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ModulesAccessApiService } from '../../../services/modules-access-api.service';
import { SessionService } from '../../../session/session.service';
import { DbUsersService } from '../../../services/db-users.service';
import { ModuleAccessEntry, ModuleAccessLevel, ModuleSummary, UserModuleAccess } from '../../../services/modules-access.types';

/** One module grant held by a user, flattened so a per-user view can list
 *  grants from several modules together. */
interface ModuleGrant {
  module_gid: string;
  module_name: string;
  access_level: ModuleAccessLevel;
  granted_by?: string | null;
  granted_date?: string | null;
  is_system_manager?: boolean;
}

/** One user, plus every module grant they hold across the modules this
 *  admin can actually see. */
interface ModuleUserGroup {
  email: string;
  grants: ModuleGrant[];
}

/**
 * Self-contained access panel for Modules — one entry in PROJECT_REGISTRY
 * (see ../project-registry.ts). Calls the same /modules/access/* backend
 * Modules itself uses (confirmed same service as gis-api.onrender.com,
 * 2026-08-17), gated the same way: you can only grant/revoke on a module
 * you already manage yourself, or hold GIS System Manager.
 */
@Component({
  selector: 'app-modules-access-panel',
  standalone: true,
  imports: [FormsModule, SlicePipe],
  templateUrl: './modules-access-panel.component.html',
})
export class ModulesAccessPanelComponent implements OnInit {
  private readonly modulesAccess = inject(ModulesAccessApiService);
  private readonly session = inject(SessionService);
  readonly dbUsers = inject(DbUsersService); // template reads dbUsers.users() for the email dropdown

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly modules = signal<ModuleSummary[]>([]);
  readonly myModuleAccess = signal<UserModuleAccess[]>([]);
  readonly managedModuleGids = computed(() => {
    const set = new Set<string>();
    for (const row of this.myModuleAccess()) {
      if (row.access_level === 'manager') set.add(row.module_gid);
    }
    return set;
  });

  readonly selectedModuleGid = signal<string>('');
  readonly moduleAccessRows = signal<ModuleAccessEntry[]>([]);
  readonly moduleAccessLoading = signal(false);
  readonly moduleAccessError = signal<string | null>(null);

  readonly showModuleGrantModal = signal(false);
  readonly moduleGranting = signal(false);
  readonly moduleGrantError = signal<string | null>(null);
  readonly moduleGrantEmail = signal('');
  readonly moduleGrantLevel = signal<ModuleAccessLevel>('contributor');

  readonly moduleRevoking = signal<string | null>(null);

  // ─── Filter + summary ────────────────────────────────────────────────────
  readonly moduleSearch = signal('');

  readonly filteredModules = computed<ModuleSummary[]>(() => {
    const q = this.moduleSearch().trim().toLowerCase();
    const list = this.modules();
    if (!q) return list;
    return list.filter((m) => m.description.toLowerCase().includes(q));
  });

  /** Modules I manage (via explicit grant or GIS System Manager bypass). */
  readonly managedCount = computed(() => {
    if (this.session.isSystemManager()) return this.modules().length;
    return this.managedModuleGids().size;
  });

  /** Modules I have any access on. */
  readonly accessibleCount = computed(() => {
    if (this.session.isSystemManager()) return this.modules().length;
    return this.myModuleAccess().length;
  });

  /** True when the current signed-in user's own module access has loaded and
   *  they have none — used to explain the empty state instead of leaving it
   *  ambiguous. */
  readonly hasNoOwnAccess = computed(
    () => this.myModuleAccess().length === 0 && !this.session.isSystemManager(),
  );

  ngOnInit(): void {
    void this.load();
    void this.dbUsers.ensureLoaded();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [moduleListRes, myModulesRes] = await Promise.all([
        this.modulesAccess.moduleList(),
        this.modulesAccess.userModules(),
      ]);
      this.modules.set(this.unwrap<ModuleSummary>(moduleListRes, 'modules'));
      this.myModuleAccess.set(this.unwrap<UserModuleAccess>(myModulesRes, 'modules'));
      // Fire-and-forget: the per-user review below fans out one call per
      // reviewable module, so it must not hold up the module list itself.
      void this.loadAllGrants();
    } catch (err: any) {
      console.error('[ModulesAccessPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load module data');
    } finally {
      this.loading.set(false);
    }
  }

  /** Modules endpoints sometimes return a bare array, sometimes `{ response, <key> }` — tolerate both. */
  private unwrap<T>(res: any, key: string): T[] {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.[key])) return res[key];
    if (Array.isArray(res?.data)) return res.data;
    return [];
  }

  moduleName(id: string): string {
    return this.modules().find((m) => m.module_gid === id)?.description ?? id.slice(0, 8);
  }

  /** GIS System Managers get the same manager bypass Modules' own panel grants them. */
  canManageModule(module_gid: string): boolean {
    return this.managedModuleGids().has(module_gid) || this.session.isSystemManager();
  }

  async selectModule(module_gid: string): Promise<void> {
    this.selectedModuleGid.set(module_gid);
    this.moduleAccessRows.set([]);
    this.moduleAccessError.set(null);
    if (!module_gid) return;
    this.moduleAccessLoading.set(true);
    try {
      const res = await this.modulesAccess.accessList(module_gid);
      this.moduleAccessRows.set(this.unwrap<ModuleAccessEntry>(res, 'access'));
    } catch (err: any) {
      console.error('[ModulesAccessPanel] module access list failed:', err);
      const status = err?.response?.status;
      this.moduleAccessError.set(
        status === 403
          ? "You don't have permission to view this module's access list."
          : (err?.response?.data?.detail ?? err?.message ?? 'Failed to load module access'),
      );
    } finally {
      this.moduleAccessLoading.set(false);
    }
  }

  openModuleGrant(): void {
    this.moduleGrantEmail.set('');
    this.moduleGrantLevel.set('contributor');
    this.moduleGrantError.set(null);
    this.showModuleGrantModal.set(true);
  }

  closeModuleGrant(): void {
    this.showModuleGrantModal.set(false);
  }

  async submitModuleGrant(): Promise<void> {
    const moduleGid = this.selectedModuleGid();
    const email = this.moduleGrantEmail().trim();
    if (!moduleGid) {
      this.moduleGrantError.set('Select a module first.');
      return;
    }
    if (!email) {
      this.moduleGrantError.set('User email is required.');
      return;
    }
    this.moduleGranting.set(true);
    this.moduleGrantError.set(null);
    try {
      // Idempotent upsert — granting an already-listed user at a new level
      // is how you change their role, same as Modules' own access panel.
      await this.modulesAccess.accessGrant(moduleGid, email, this.moduleGrantLevel());
      this.showModuleGrantModal.set(false);
      await this.selectModule(moduleGid);
    } catch (err: any) {
      console.error('[ModulesAccessPanel] grant failed:', err);
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (status === 404) {
        this.moduleGrantError.set(`"${email}" isn't registered — make sure the user has signed up first.`);
      } else if (status === 403) {
        this.moduleGrantError.set("You don't have permission to grant access on this module.");
      } else {
        this.moduleGrantError.set(detail ?? err?.message ?? 'Failed to grant access');
      }
    } finally {
      this.moduleGranting.set(false);
    }
  }

  async revokeModuleAccess(row: ModuleAccessEntry): Promise<void> {
    const moduleGid = this.selectedModuleGid();
    if (!moduleGid) return;
    this.moduleRevoking.set(row.user_email);
    try {
      await this.modulesAccess.accessRevoke(moduleGid, row.user_email);
      this.moduleAccessRows.update((rows) => rows.filter((r) => r.user_email !== row.user_email));
    } catch (err: any) {
      console.error('[ModulesAccessPanel] revoke failed:', err);
      this.moduleAccessError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke access');
    } finally {
      this.moduleRevoking.set(null);
    }
  }

  // --- Users & their module access ----------------------------------------
  // Mirrors the Stock panel's "Users & their access" view. The per-module
  // list answers "who is on THIS module"; an access review needs the other
  // direction - "what does this person have, across everything" - which
  // nothing surfaced before.
  //
  // Built by fanning out accessList() over every module this admin can
  // manage, in parallel. A module the server 403s on is skipped silently
  // rather than failing the whole view: that is the documented per-module
  // gating, not an error, and one unmanaged module should not blank out the
  // rest. The count of skipped modules IS surfaced, so an incomplete
  // picture never looks like a complete one.
  readonly allGrantsLoading = signal(false);
  readonly allGrantsError = signal<string | null>(null);
  readonly moduleGrants = signal<ModuleGrant[] | null>(null);
  readonly skippedModules = signal(0);
  readonly userSearch = signal('');
  readonly expandedUsers = signal<Set<string>>(new Set());

  /** Modules whose access list this admin is allowed to read. */
  readonly reviewableModules = computed<ModuleSummary[]>(() => {
    if (this.session.isSystemManager()) return this.modules();
    const managed = this.managedModuleGids();
    return this.modules().filter((m) => managed.has(m.module_gid));
  });

  readonly groupedByUser = computed<ModuleUserGroup[]>(() => {
    const grants = this.moduleGrants();
    if (!grants) return [];
    const q = this.userSearch().trim().toLowerCase();
    const byEmail = new Map<string, ModuleGrant[]>();
    for (const g of grants) {
      const key = String((g as any).user_email ?? '').toLowerCase();
      if (!key) continue;
      const list = byEmail.get(key) ?? [];
      list.push(g);
      byEmail.set(key, list);
    }
    return Array.from(byEmail.entries())
      .map(([email, list]) => ({ email, grants: list }))
      .filter((row) => !q || row.email.includes(q) || row.grants.some((g) => g.module_name.toLowerCase().includes(q)))
      .sort((a, b) => a.email.localeCompare(b.email));
  });

  async loadAllGrants(): Promise<void> {
    const targets = this.reviewableModules();
    if (targets.length === 0) {
      this.moduleGrants.set([]);
      this.skippedModules.set(0);
      return;
    }
    this.allGrantsLoading.set(true);
    this.allGrantsError.set(null);
    let skipped = 0;
    try {
      const results = await Promise.all(
        targets.map(async (m) => {
          try {
            const res = await this.modulesAccess.accessList(m.module_gid);
            return this.unwrap<ModuleAccessEntry>(res, 'access').map((row) => ({
              ...row,
              module_gid: m.module_gid,
              module_name: m.description,
            }));
          } catch {
            // 403 on a module this admin does not manage - expected, see
            // the doc comment above.
            skipped++;
            return [];
          }
        }),
      );
      this.moduleGrants.set(results.flat() as any);
      this.skippedModules.set(skipped);
    } catch (err: any) {
      console.error('[ModulesAccessPanel] all-grants load failed:', err);
      this.allGrantsError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load module access');
    } finally {
      this.allGrantsLoading.set(false);
    }
  }

  toggleUserExpanded(email: string): void {
    this.expandedUsers.update((set) => {
      const next = new Set(set);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  isUserExpanded(email: string): boolean {
    return this.expandedUsers().has(email);
  }

  userInitial(email: string): string {
    return (email.trim()[0] ?? '?').toUpperCase();
  }

  /** "3 modules - 1 as manager" - the shape of someone's access at a glance,
   *  without expanding the row. */
  userGrantSummary(row: ModuleUserGroup): string {
    const n = row.grants.length;
    const managers = row.grants.filter((g) => g.access_level === 'manager').length;
    const base = n + ' module' + (n === 1 ? '' : 's');
    return managers > 0 ? base + ' \u00b7 ' + managers + ' as manager' : base;
  }

  /** Distinct levels held, for the pills on the collapsed row. */
  userLevels(row: ModuleUserGroup): ModuleAccessLevel[] {
    const seen = new Set<ModuleAccessLevel>();
    for (const g of row.grants) seen.add(g.access_level);
    return Array.from(seen);
  }

  /** Revoke straight from the per-user view - refreshes both this view and
   *  the single-module list if that module happens to be open. */
  readonly rowRevoking = signal('');

  async revokeFromUserView(email: string, g: ModuleGrant): Promise<void> {
    this.rowRevoking.set(email + '::' + g.module_gid);
    try {
      await this.modulesAccess.accessRevoke(g.module_gid, email);
      this.moduleGrants.update((list) =>
        (list ?? []).filter(
          (x) => !(x.module_gid === g.module_gid && String((x as any).user_email ?? '').toLowerCase() === email),
        ),
      );
      if (this.selectedModuleGid() === g.module_gid) await this.selectModule(g.module_gid);
    } catch (err: any) {
      console.error('[ModulesAccessPanel] revoke from user view failed:', err);
      this.allGrantsError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke access');
    } finally {
      this.rowRevoking.set('');
    }
  }

}
