import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DbUsersService } from '../../../services/db-users.service';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { GisAccessApiService } from '../../../services/gis-access-api.service';
import { ModulesAccessApiService } from '../../../services/modules-access-api.service';
import { RolesApiService } from '../../../services/roles-api.service';
import { SessionService } from '../../../session/session.service';
import { OrgRow, StockLocation } from '../../../services/stock-access.types';
import { ModuleAccessEntry, ModuleSummary } from '../../../services/modules-access.types';

type GrantSystem = 'stock' | 'gis' | 'modules' | 'roles';

/** One access grant, whichever of the 4 systems it came from, normalized to
 *  the same shape stock-access-panel.component.html's own grants table
 *  already renders (Scope | Target | Role | Action) — this table is that
 *  exact pattern, just fed from all 4 systems instead of one. */
interface UnifiedGrant {
  system: GrantSystem;
  /** Unique across every grant on the page — used for track + the
   *  in-flight revoke key, never shown. */
  key: string;
  scope: string;
  targetLabel: string;
  role: string;
  /** What revoke() actually needs to identify this grant to its own
   *  system's API — Stock's access_id, GIS's project name, Modules'
   *  module_gid, or Roles' role_gid. One field, meaning depends on system,
   *  since each API only ever needs exactly one besides the email. */
  refId: string;
}

interface UserGrantGroup {
  email: string;
  user_gid: string;
  grants: UnifiedGrant[];
}

const SYSTEM_LABEL: Record<GrantSystem, string> = {
  stock: 'Stock', gis: 'GIS project', modules: 'Module', roles: 'Client role',
};

/**
 * The universal access table — every db-linked user's grants across all 4
 * systems this app manages (Stock, GIS projects, Modules, client roles) in
 * one place, same expandable-row/nested-table/inline-revoke pattern as
 * stock-access-panel.component.html's own "Users & their access" (which
 * stays Stock-only — this is the cross-system superset, not a replacement).
 * Overview + revoke only, on purpose — granting new access still happens in
 * each system's own panel, which already knows that system's specific
 * rules (Stock's scope tiers, GIS's project-name keying, Modules' access
 * levels, Roles' role/privilege model).
 *
 * GIS has no bulk "everyone's projects" endpoint (user-centric only, see
 * gis-access-panel.component.ts's own doc comment) — so this fetches
 * userProjects(email) per db-linked user in parallel. Modules' accessList()
 * is per-module and 403s for a module the VIEWER doesn't manage — so the
 * Modules grants shown here can be an undercount for anyone who isn't a
 * GIS System Manager, flagged in the UI rather than silently incomplete.
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

  readonly locations = signal<StockLocation[]>([]);
  readonly orgs = signal<OrgRow[]>([]);
  readonly modules = signal<ModuleSummary[]>([]);
  /** True once loaded — modulesLimited only means something after that. */
  readonly modulesLimited = signal(false);

  private readonly groupsByEmail = signal<Map<string, UserGrantGroup>>(new Map());

  // ─── Filter bar — same shape as Stock's own grants table ──────────────────
  readonly search = signal('');
  readonly systemFilter = signal<GrantSystem | ''>('');

  readonly hasActiveFilters = computed(() => !!this.search().trim() || !!this.systemFilter());

  clearFilters(): void {
    this.search.set('');
    this.systemFilter.set('');
  }

  readonly groupedByUser = computed<UserGrantGroup[]>(() => {
    const q = this.search().trim().toLowerCase();
    const sys = this.systemFilter();
    const groups = Array.from(this.groupsByEmail().values());
    const out: UserGrantGroup[] = [];
    for (const grp of groups) {
      let grants = grp.grants;
      if (sys) grants = grants.filter((g) => g.system === sys);
      if (q) {
        grants = grants.filter((g) =>
          [grp.email, g.targetLabel, g.role, g.scope, SYSTEM_LABEL[g.system]].join(' ').toLowerCase().includes(q),
        );
      }
      if (grants.length > 0) out.push({ ...grp, grants });
    }
    return out.sort((a, b) => a.email.localeCompare(b.email));
  });

  readonly totalGrantCount = computed(() => Array.from(this.groupsByEmail().values()).reduce((n, g) => n + g.grants.length, 0));

  readonly expandedUsers = signal<Set<string>>(new Set());
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
    return email ? email.charAt(0).toUpperCase() : '?';
  }

  systemLabel(s: GrantSystem): string {
    return SYSTEM_LABEL[s];
  }

  /** Distinct systems a user has any grant in, in a fixed display order —
   *  used for the collapsed row's summary pills. */
  distinctSystems(group: UserGrantGroup): GrantSystem[] {
    const present = new Set(group.grants.map((g) => g.system));
    return (['stock', 'gis', 'modules', 'roles'] as GrantSystem[]).filter((s) => present.has(s));
  }

  readonly revokingKey = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

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

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.dbUsers.ensureLoaded();
      const users = this.dbUsers.users();
      const usersByGid = new Map(users.map((u) => [u.user_gid, u]));

      const [locRes, grantRes, orgRes, modulesRes, rolesRes] = await Promise.all([
        this.stockAccess.locationsList(),
        this.stockAccess.locationAccessList(),
        this.stockAccess.orgsList(),
        this.modulesAccess.moduleList(),
        this.rolesApi.userRolesList(),
      ]);
      this.locations.set(locRes?.locations ?? []);
      this.orgs.set(orgRes?.orgs ?? []);
      const modules = this.unwrap<ModuleSummary>(modulesRes, 'modules');
      this.modules.set(modules);

      const groups = new Map<string, UserGrantGroup>();
      const ensure = (email: string, user_gid: string) => {
        let g = groups.get(email);
        if (!g) {
          g = { email, user_gid, grants: [] };
          groups.set(email, g);
        }
        return g;
      };

      // Stock — user_id-keyed; only resolvable for db-linked users we have a matching gid for.
      for (const g of grantRes?.access ?? []) {
        const u = usersByGid.get(g.user_id);
        if (!u) continue;
        ensure(u.email, u.user_gid).grants.push({
          system: 'stock',
          key: 'stock:' + g.global_id,
          scope: g.scope,
          targetLabel:
            g.scope === 'location' ? this.locationName(g.location_id) :
            g.scope === 'org' ? this.orgName(g.org_id) : 'Whole client',
          role: g.role,
          refId: g.global_id,
        });
      }

      // Modules — one call per module, naturally gives every user's access to it at once.
      const isSystemManager = this.session.isSystemManager();
      this.modulesLimited.set(!isSystemManager);
      const moduleResults = await Promise.all(
        modules.map((m) =>
          this.modulesAccess.accessList(m.module_gid)
            .then((res) => ({ m, list: this.unwrap<ModuleAccessEntry>(res, 'access') }))
            .catch(() => ({ m, list: [] as ModuleAccessEntry[] })), // 403 on an unmanaged module — expected
        ),
      );
      for (const { m, list } of moduleResults) {
        for (const entry of list) {
          const u = users.find((x) => x.email.toLowerCase() === entry.user_email?.toLowerCase());
          if (!u) continue; // not linked to this db
          ensure(u.email, u.user_gid).grants.push({
            system: 'modules',
            key: 'mod:' + m.module_gid + ':' + u.email,
            scope: 'module',
            targetLabel: m.description,
            role: entry.access_level,
            refId: m.module_gid,
          });
        }
      }

      // Client roles — gid-keyed, no email on the row; cross-referenced against db-linked users.
      for (const a of rolesRes?.assignments ?? []) {
        const u = usersByGid.get(a.user_gid);
        if (!u) continue;
        ensure(u.email, u.user_gid).grants.push({
          system: 'roles',
          key: 'role:' + a.role_gid + ':' + u.email,
          scope: 'client',
          targetLabel: 'Whole client',
          role: a.role_name,
          refId: a.role_gid,
        });
      }

      // GIS — no bulk endpoint; one call per db-linked user, in parallel.
      const gisResults = await Promise.all(
        users.map((u) => this.gisAccess.userProjects(u.email).then((list) => ({ u, list })).catch(() => ({ u, list: [] }))),
      );
      for (const { u, list } of gisResults) {
        for (const p of list) {
          ensure(u.email, u.user_gid).grants.push({
            system: 'gis',
            key: 'gis:' + u.email + ':' + p.name,
            scope: 'project',
            targetLabel: p.name,
            role: 'member',
            refId: p.name,
          });
        }
      }

      this.groupsByEmail.set(groups);
    } catch (err: any) {
      console.error('[UserDirectoryPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load the access overview');
    } finally {
      this.loading.set(false);
    }
  }

  private removeGrant(email: string, key: string): void {
    this.groupsByEmail.update((map) => {
      const g = map.get(email);
      if (!g) return map;
      const next = new Map(map);
      next.set(email, { ...g, grants: g.grants.filter((x) => x.key !== key) });
      return next;
    });
  }

  async revoke(email: string, grant: UnifiedGrant): Promise<void> {
    this.revokingKey.set(grant.key);
    try {
      switch (grant.system) {
        case 'stock':
          await this.stockAccess.locationAccessRevoke(grant.refId);
          break;
        case 'gis':
          await this.gisAccess.removeProject(email, grant.refId);
          break;
        case 'modules':
          await this.modulesAccess.accessRevoke(grant.refId, email);
          break;
        case 'roles':
          await this.rolesApi.userRoleRevoke({ user_email: email, role_gid: grant.refId });
          break;
      }
      this.removeGrant(email, grant.key);
    } catch (err: any) {
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke');
    } finally {
      this.revokingKey.set(null);
    }
  }
}
