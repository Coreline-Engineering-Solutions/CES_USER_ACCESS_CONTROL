import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DbUsersService, DbLinkedUser } from '../../../services/db-users.service';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { GisAccessApiService } from '../../../services/gis-access-api.service';
import { ModulesAccessApiService } from '../../../services/modules-access-api.service';
import { RolesApiService } from '../../../services/roles-api.service';
import { SessionService } from '../../../session/session.service';
import { LocationAccessGrant, OrgRow, StockLocation } from '../../../services/stock-access.types';
import { GisProject } from '../../../services/gis-access.types';
import { ModuleSummary, ModuleAccessEntry, ModuleAccessLevel } from '../../../services/modules-access.types';
import { UserRoleAssignment } from '../../../services/roles.types';

interface ModuleAccessRow {
  module_gid: string;
  module_name: string;
  access_level: ModuleAccessLevel;
}

/** Real UUID, not an email masquerading as one — same reasoning/regex as
 *  every other UUID-gated picker in this app. Stock grants are keyed by a
 *  real user_gid; a db-linked user we only ever saw via the email-only auth
 *  source has no such id to filter by, so that section is skipped for them
 *  rather than silently showing nothing and looking broken. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One table — every user linked to the active db — with an info button per
 * row that pulls together everything they hold across all four access
 * systems this app manages: Stock grants, GIS project membership, Modules
 * access, and client roles. Each system keys users differently (Stock by
 * user_gid, GIS/Modules/Roles by email — Roles' /roles/users/list happens
 * to accept an email filter server-side despite returning gid-only rows),
 * so this component pulls from all four independently rather than trying
 * to force one shared key.
 *
 * Modules is the one section that can come back incomplete for a non-
 * System-Manager viewer: /modules/access/list 403s per-module for anyone
 * who doesn't manage that specific module (server-enforced, same as
 * Modules' own access panel) — only a GIS System Manager viewing this page
 * sees every module's access for a user in one pass. Flagged in the UI
 * rather than silently swallowed.
 */
@Component({
  selector: 'app-user-directory-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './user-directory-panel.component.html',
})
export class UserDirectoryPanelComponent implements OnInit {
  readonly dbUsers = inject(DbUsersService);
  private readonly stockAccess = inject(StockAccessApiService);
  private readonly gisAccess = inject(GisAccessApiService);
  private readonly modulesAccess = inject(ModulesAccessApiService);
  private readonly rolesApi = inject(RolesApiService);
  readonly session = inject(SessionService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly search = signal('');

  readonly filteredUsers = computed<DbLinkedUser[]>(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.dbUsers.users();
    if (!q) return list;
    return list.filter((u) => u.email.toLowerCase().includes(q));
  });

  // ─── Reference data, loaded once, used to resolve names in the detail panel ──
  readonly locations = signal<StockLocation[]>([]);
  readonly orgs = signal<OrgRow[]>([]);
  readonly allGrants = signal<LocationAccessGrant[]>([]);
  readonly modules = signal<ModuleSummary[]>([]);

  // ─── Info drill-down ──────────────────────────────────────────────────────
  readonly detailUser = signal<DbLinkedUser | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly detailStockGrants = signal<LocationAccessGrant[]>([]);
  readonly detailGisProjects = signal<GisProject[]>([]);
  readonly detailModuleAccess = signal<ModuleAccessRow[]>([]);
  readonly detailClientRoles = signal<UserRoleAssignment[]>([]);
  /** True when the current viewer isn't a System Manager — Modules section
   *  above may be missing modules they don't personally manage. */
  readonly detailModulesLimited = signal(false);
  readonly detailHasResolvedId = computed(() => UUID_RE.test(this.detailUser()?.user_gid ?? ''));

  readonly revokingKey = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.dbUsers.ensureLoaded();
      const [locRes, grantRes, orgRes, modRes] = await Promise.all([
        this.stockAccess.locationsList(),
        this.stockAccess.locationAccessList(),
        this.stockAccess.orgsList(),
        this.modulesAccess.moduleList(),
      ]);
      this.locations.set(locRes?.locations ?? []);
      this.allGrants.set(grantRes?.access ?? []);
      this.orgs.set((orgRes as any)?.orgs ?? []);
      this.modules.set(this.unwrap<ModuleSummary>(modRes, 'modules'));
    } catch (err: any) {
      console.error('[UserDirectoryPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load user directory');
    } finally {
      this.loading.set(false);
    }
  }

  /** Modules endpoints sometimes return a bare array, sometimes `{ response, <key> }`. */
  private unwrap<T>(res: any, key: string): T[] {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.[key])) return res[key];
    if (Array.isArray(res?.data)) return res.data;
    return [];
  }

  locationName(id: string | null | undefined): string {
    if (!id) return '—';
    return this.locations().find((l) => l.global_id === id)?.name ?? id.slice(0, 8) + '…';
  }

  orgName(id: string | null | undefined): string {
    if (!id) return '—';
    return this.orgs().find((o) => o.client_db_gid === id)?.name ?? `Org ${id.slice(0, 6)}…`;
  }

  async openDetail(u: DbLinkedUser): Promise<void> {
    this.detailUser.set(u);
    this.detailError.set(null);
    this.detailLoading.set(true);
    this.detailStockGrants.set([]);
    this.detailGisProjects.set([]);
    this.detailModuleAccess.set([]);
    this.detailClientRoles.set([]);
    this.detailModulesLimited.set(false);

    try {
      // Stock grants: filter the already-loaded system-wide list by this
      // user's resolved gid — only meaningful when we actually have a real
      // UUID for them (see UUID_RE doc comment above).
      if (UUID_RE.test(u.user_gid)) {
        this.detailStockGrants.set(this.allGrants().filter((g) => g.user_id === u.user_gid));
      }

      const [gisProjects, rolesRes] = await Promise.all([
        this.gisAccess.userProjects(u.email).catch(() => [] as GisProject[]),
        this.rolesApi.userRolesList(u.email).catch(() => ({ assignments: [] as UserRoleAssignment[] })),
      ]);
      this.detailGisProjects.set(gisProjects);
      this.detailClientRoles.set(rolesRes?.assignments ?? []);

      // Modules — query every module in parallel; a 403 on one the viewer
      // doesn't manage is expected and skipped silently, not surfaced as an
      // error. isSystemManager() is what determines whether that gap can
      // exist at all for THIS viewer.
      const isSystemManager = this.session.isSystemManager();
      this.detailModulesLimited.set(!isSystemManager);
      const results = await Promise.all(
        this.modules().map(async (m) => {
          try {
            const res = await this.modulesAccess.accessList(m.module_gid);
            const list = this.unwrap<ModuleAccessEntry>(res, 'access');
            const hit = list.find((r) => r.user_email?.toLowerCase() === u.email.toLowerCase());
            return hit ? { module_gid: m.module_gid, module_name: m.description, access_level: hit.access_level } : null;
          } catch {
            return null; // 403 (not managed) or any other per-module failure — skip, not fatal
          }
        }),
      );
      this.detailModuleAccess.set(results.filter((r): r is ModuleAccessRow => r !== null));
    } catch (err: any) {
      console.error('[UserDirectoryPanel] detail load failed:', err);
      this.detailError.set(err?.response?.data?.detail ?? err?.message ?? "Failed to load this user's access");
    } finally {
      this.detailLoading.set(false);
    }
  }

  closeDetail(): void {
    this.detailUser.set(null);
  }

  async revokeStockGrant(g: LocationAccessGrant): Promise<void> {
    this.revokingKey.set('stock:' + g.global_id);
    try {
      await this.stockAccess.locationAccessRevoke(g.global_id);
      this.detailStockGrants.update((list) => list.filter((x) => x.global_id !== g.global_id));
      this.allGrants.update((list) => list.filter((x) => x.global_id !== g.global_id));
    } catch (err: any) {
      this.detailError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke');
    } finally {
      this.revokingKey.set(null);
    }
  }

  async removeGisProject(p: GisProject): Promise<void> {
    const u = this.detailUser();
    if (!u) return;
    this.revokingKey.set('gis:' + p.name);
    try {
      await this.gisAccess.removeProject(u.email, p.name);
      this.detailGisProjects.update((list) => list.filter((x) => x.name !== p.name));
    } catch (err: any) {
      this.detailError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to remove');
    } finally {
      this.revokingKey.set(null);
    }
  }

  async revokeClientRole(a: UserRoleAssignment): Promise<void> {
    const u = this.detailUser();
    if (!u) return;
    this.revokingKey.set('role:' + a.role_gid);
    try {
      await this.rolesApi.userRoleRevoke({ user_email: u.email, role_gid: a.role_gid });
      this.detailClientRoles.update((list) => list.filter((x) => x.role_gid !== a.role_gid));
    } catch (err: any) {
      this.detailError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke');
    } finally {
      this.revokingKey.set(null);
    }
  }

  async revokeModuleAccess(row: ModuleAccessRow): Promise<void> {
    const u = this.detailUser();
    if (!u) return;
    this.revokingKey.set('mod:' + row.module_gid);
    try {
      await this.modulesAccess.accessRevoke(row.module_gid, u.email);
      this.detailModuleAccess.update((list) => list.filter((x) => x.module_gid !== row.module_gid));
    } catch (err: any) {
      this.detailError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke');
    } finally {
      this.revokingKey.set(null);
    }
  }
}
