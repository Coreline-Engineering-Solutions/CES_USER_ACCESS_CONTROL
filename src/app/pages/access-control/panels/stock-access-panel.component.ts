import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TitleCasePipe } from '@angular/common';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { SessionService } from '../../../session/session.service';
import { AccessRole, AccessScope, LocationAccessGrant, OrgRow, StockLocation, StockUserRef } from '../../../services/stock-access.types';

/** One user, plus every grant they currently hold in this project. */
interface UserGrantGroup {
  user_id: string;
  email: string;
  grants: LocationAccessGrant[];
}

/**
 * Last-resort label for an org_id with no entry in the real org directory
 * (`/stock/orgs/list`, loaded into `realOrgs` below) yet — e.g. a client
 * database already in use for locations/grants that nobody's registered
 * a name for here. `org_id` in this schema is a client_db_gid; the real
 * directory is what finally gives it a name — see orgName() below, which
 * checks that first and only falls back to this map.
 */
const ORG_LABEL_OVERRIDES: Record<string, string> = {
  '00000000-0000-0000-0000-000000000000': 'Demo Test Org',
  '20ad40a4-9134-4bd6-8451-d840e695015d': 'Acme Demo Contractors',
};

/**
 * Self-contained access panel for Stock Manager — one entry in
 * PROJECT_REGISTRY (see ../project-registry.ts). Owns its own data load and
 * API calls; the shell only decides whether this component is on screen.
 */
@Component({
  selector: 'app-stock-access-panel',
  standalone: true,
  imports: [FormsModule, TitleCasePipe],
  templateUrl: './stock-access-panel.component.html',
})
export class StockAccessPanelComponent implements OnInit {
  private readonly stockAccess = inject(StockAccessApiService);
  private readonly session = inject(SessionService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly canAdmin = signal(false); // _stock_admin — grant/revoke location access

  readonly locations = signal<StockLocation[]>([]);
  readonly grants = signal<LocationAccessGrant[]>([]);
  readonly users = signal<StockUserRef[]>([]);
  readonly usersLoading = signal(false);

  // ─── Filter/sort over the grants table ──────────────────────────────────
  // With multiple orgs each holding a handful of users at various levels,
  // scrolling a flat table is the failure mode; the same filter-bar pattern
  // Stock Manager uses (search + narrowing dropdowns + clear) keeps it
  // scannable at scale.
  readonly grantSearch = signal('');
  readonly grantRoleFilter = signal<AccessRole | ''>('');
  readonly grantScopeFilter = signal<AccessScope | ''>('');
  readonly grantOrgFilter = signal<string>('');

  readonly hasActiveFilters = computed(
    () =>
      !!this.grantSearch().trim() ||
      !!this.grantRoleFilter() ||
      !!this.grantScopeFilter() ||
      !!this.grantOrgFilter(),
  );

  clearFilters(): void {
    this.grantSearch.set('');
    this.grantRoleFilter.set('');
    this.grantScopeFilter.set('');
    this.grantOrgFilter.set('');
  }

  /** Search over the human-readable resolutions (email/location name/org
   *  name), not the raw UUIDs — matching how the columns display. */
  readonly filteredGrants = computed(() => {
    const q = this.grantSearch().trim().toLowerCase();
    const role = this.grantRoleFilter();
    const scope = this.grantScopeFilter();
    const orgFilter = this.grantOrgFilter();
    return this.grants().filter((g) => {
      if (role && g.role !== role) return false;
      if (scope && g.scope !== scope) return false;
      if (orgFilter) {
        // "Belongs to this org" = grant is org-scoped for that org, OR
        // location-scoped and the location's own org matches.
        if (g.scope === 'org' && g.org_id !== orgFilter) return false;
        if (g.scope === 'location') {
          const loc = this.locations().find((l) => l.global_id === g.location_id);
          if (!loc || loc.org_id !== orgFilter) return false;
        }
        if (g.scope === 'client') return false;
      }
      if (q) {
        const haystack = [
          this.userEmail(g.user_id),
          this.locationName(g.location_id),
          this.orgName(g.org_id),
          g.role,
          g.scope,
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  });

  /**
   * One entry per user, holding all of their grants — so an admin sees "this
   * person's whole footprint on Stock" in one row and clicks to expand, rather
   * than scrolling a flat table trying to reassemble it in their head. Built
   * from `filteredGrants()` so the existing filter bar keeps working (only
   * users with at least one matching grant show up).
   *
   * Unknown-user grants (user_id present but not in the loaded users list —
   * happens if the user is in a different org's directory) still get grouped
   * under their user_id; we show a truncated id badge instead of an email.
   */
  readonly groupedByUser = computed<UserGrantGroup[]>(() => {
    const grants = this.filteredGrants();
    const usersByGid = new Map(this.users().map((u) => [u.user_gid, u]));
    const groups = new Map<string, UserGrantGroup>();
    for (const g of grants) {
      const uid = String(g.user_id ?? '').trim() || '__unknown__';
      let group = groups.get(uid);
      if (!group) {
        const known = usersByGid.get(uid);
        group = {
          user_id: uid,
          email: known?.email ?? '',
          grants: [],
        };
        groups.set(uid, group);
      }
      group.grants.push(g);
    }
    // Sort users by email (empty emails last, then id-only rows), then each
    // user's grants by role then scope so the expanded rows are predictable.
    const list = Array.from(groups.values()).sort((a, b) => {
      if (!a.email && b.email) return 1;
      if (a.email && !b.email) return -1;
      return (a.email || a.user_id).localeCompare(b.email || b.user_id);
    });
    for (const grp of list) {
      grp.grants.sort((a, b) => (a.role + a.scope).localeCompare(b.role + b.scope));
    }
    return list;
  });

  /** Which user cards are currently expanded. */
  readonly expandedUsers = signal<Set<string>>(new Set());

  toggleUserExpanded(user_id: string): void {
    this.expandedUsers.update((set) => {
      const next = new Set(set);
      if (next.has(user_id)) next.delete(user_id);
      else next.add(user_id);
      return next;
    });
  }

  isUserExpanded(user_id: string): boolean {
    return this.expandedUsers().has(user_id);
  }

  /** Initials shown in the round avatar chip — email letter, or "?" for
   *  unknown-user rows. */
  userInitial(group: UserGrantGroup): string {
    if (group.email) return group.email.charAt(0).toUpperCase();
    return '?';
  }

  /** Compact summary of a user's grants — "3 locations · 1 org", "auditor at whole client", etc. */
  userGrantSummary(group: UserGrantGroup): string {
    const scopeCounts: Record<AccessScope, number> = { location: 0, org: 0, client: 0 };
    for (const g of group.grants) scopeCounts[g.scope]++;
    const parts: string[] = [];
    if (scopeCounts.location) parts.push(`${scopeCounts.location} location${scopeCounts.location === 1 ? '' : 's'}`);
    if (scopeCounts.org) parts.push(`${scopeCounts.org} org${scopeCounts.org === 1 ? '' : 's'}`);
    if (scopeCounts.client) parts.push(`whole client`);
    return parts.join(' · ') || 'no grants';
  }

  /** Distinct roles the user holds, for the pill row on the collapsed card. */
  userRoles(group: UserGrantGroup): AccessRole[] {
    const seen = new Set<AccessRole>();
    for (const g of group.grants) seen.add(g.role);
    return Array.from(seen);
  }

  readonly orgs = computed(() => {
    const map = new Map<string, { org_id: string; count: number; types: Set<string> }>();
    for (const l of this.locations()) {
      const e = map.get(l.org_id) ?? { org_id: l.org_id, count: 0, types: new Set<string>() };
      e.count += 1;
      e.types.add(l.location_type);
      map.set(l.org_id, e);
    }
    return Array.from(map.values());
  });

  // ─── Organisation directory ──────────────────────────────────────────────
  // The real thing — /stock/orgs/create + /stock/orgs/list. This app is the
  // sole admin surface for it (org creation was pulled out of Stock Manager
  // for exactly this reason). orgName() below reads from this first.
  readonly realOrgs = signal<OrgRow[]>([]);
  readonly realOrgsByClientDbGid = computed(() => new Map(this.realOrgs().map((o) => [o.client_db_gid, o])));

  readonly showCreateOrgModal = signal(false);
  readonly orgDraftName = signal('');
  readonly orgDraftClientDbGid = signal('');
  readonly orgCreating = signal(false);
  readonly orgCreateError = signal<string | null>(null);

  openCreateOrg(): void {
    this.orgDraftName.set('');
    this.orgDraftClientDbGid.set('');
    this.orgCreateError.set(null);
    this.showCreateOrgModal.set(true);
  }

  closeCreateOrg(): void {
    this.showCreateOrgModal.set(false);
  }

  async submitCreateOrg(): Promise<void> {
    const name = this.orgDraftName().trim();
    const clientDbGid = this.orgDraftClientDbGid().trim();
    if (!name || !clientDbGid) {
      this.orgCreateError.set('Name and client database ID are both required.');
      return;
    }
    this.orgCreating.set(true);
    this.orgCreateError.set(null);
    try {
      await this.stockAccess.orgCreate({ name, client_db_gid: clientDbGid });
      this.showCreateOrgModal.set(false);
      await this.loadRealOrgs();
    } catch (err: any) {
      console.error('[StockAccessPanel] org create failed:', err);
      this.orgCreateError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to create organisation');
    } finally {
      this.orgCreating.set(false);
    }
  }

  private async loadRealOrgs(): Promise<void> {
    try {
      const result = await this.stockAccess.orgsList();
      this.realOrgs.set(result?.orgs ?? []);
    } catch (err: any) {
      // Non-fatal — orgName() falls back to the generic label map below,
      // so a permission gap on one database doesn't blank the whole panel.
      console.warn('[StockAccessPanel] real org directory load failed:', err);
    }
  }

  /** Every grantable role, in the same order as the filter bar's dropdown
   *  above — kept as one canonical list so the grant form never drifts out
   *  of sync with what the rest of this panel already treats as valid. */
  readonly ALL_ROLES: AccessRole[] = ['viewer', 'operator', 'controller', 'auditor', 'custodian', 'receiver'];

  readonly showGrantModal = signal(false);
  readonly granting = signal(false);
  readonly grantError = signal<string | null>(null);
  readonly grantUserId = signal('');
  /** Multi-select — a user can hold several roles on the same scope (e.g.
   *  Operator + Auditor on one location), and forcing one grant per modal
   *  visit meant re-opening this dialog for every extra role. */
  readonly grantRoles = signal<Set<AccessRole>>(new Set());
  readonly grantScope = signal<AccessScope>('location');
  readonly grantLocationId = signal('');
  readonly grantOrgId = signal('');

  /** Roles the target user already holds for the *exact* scope being edited
   *  — live over grantUserId/grantScope/grantLocationId/grantOrgId so the
   *  modal updates as those change. Used to grey out roles that would
   *  just duplicate an existing grant, so "which roles are already
   *  assigned" is visible before you submit, not after a 400 comes back. */
  readonly existingRolesForTarget = computed<Set<AccessRole>>(() => {
    const userId = this.grantUserId().trim();
    if (!userId) return new Set();
    const scope = this.grantScope();
    const locationId = this.grantLocationId();
    const orgId = this.grantOrgId().trim();
    const roles = new Set<AccessRole>();
    for (const g of this.grants()) {
      if (g.user_id !== userId || g.scope !== scope) continue;
      if (scope === 'location' && g.location_id !== locationId) continue;
      if (scope === 'org' && g.org_id !== orgId) continue;
      roles.add(g.role);
    }
    return roles;
  });

  toggleGrantRole(role: AccessRole): void {
    if (this.existingRolesForTarget().has(role)) return; // already granted — nothing to toggle
    this.grantRoles.update((set) => {
      const next = new Set(set);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  readonly revoking = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
    void this.session.hasPrivilege('_stock_admin').then((v) => this.canAdmin.set(v));
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [locRes, grantRes] = await Promise.all([
        this.stockAccess.locationsList(),
        this.stockAccess.locationAccessList(),
      ]);
      this.locations.set(locRes?.locations ?? []);
      this.grants.set(grantRes?.access ?? []);
      void this.loadUsers();
      void this.loadRealOrgs();
    } catch (err: any) {
      console.error('[StockAccessPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load stock access data');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Real, pickable users — one `/admin/db-users` call per org_id currently
   * in use (org_id == client database gid today), merged and de-duped, so
   * the grant form offers an actual "who is this" list instead of asking
   * an admin to type a UUID by hand. Best-effort per org: one failing org
   * doesn't block the others.
   */
  private async loadUsers(): Promise<void> {
    const orgIds = this.orgs().map((o) => o.org_id).filter(Boolean);
    if (orgIds.length === 0) return;
    this.usersLoading.set(true);
    try {
      const lists = await Promise.all(
        orgIds.map((gid) =>
          this.stockAccess.dbUsersList(gid).catch((err) => {
            console.warn('[StockAccessPanel] users lookup failed for org', gid, err);
            return null;
          }),
        ),
      );
      const byGid = new Map<string, StockUserRef>();
      for (const res of lists) {
        const list = res?.users ?? res?.emails ?? res?.email_list ?? res?.user_list ?? res?.data ?? res;
        if (!Array.isArray(list)) continue;
        for (const u of list) {
          const user_gid = String(typeof u === 'string' ? '' : (u?.user_gid ?? u?.gid ?? '')).trim();
          const email = String(typeof u === 'string' ? u : (u?.email ?? u?.user_email ?? '')).trim();
          if (email && user_gid) byGid.set(user_gid, { user_gid, email });
        }
      }
      this.users.set(Array.from(byGid.values()).sort((a, b) => a.email.localeCompare(b.email)));
    } finally {
      this.usersLoading.set(false);
    }
  }

  locationName(id: string | null): string {
    if (!id) return '—';
    return this.locations().find((l) => l.global_id === id)?.name ?? id.slice(0, 8);
  }

  userEmail(user_id: string | null | undefined): string {
    if (!user_id) return '—';
    return this.users().find((u) => u.user_gid === user_id)?.email ?? user_id.slice(0, 8) + '…';
  }

  orgName(org_id: string | null | undefined): string {
    if (!org_id) return '—';
    const real = this.realOrgsByClientDbGid().get(org_id);
    if (real) return real.name;
    return ORG_LABEL_OVERRIDES[org_id] ?? `Demo Org ${org_id.slice(0, 6)}`;
  }

  openGrant(orgId?: string): void {
    this.grantUserId.set('');
    this.grantRoles.set(new Set());
    this.grantScope.set(orgId ? 'org' : 'location');
    this.grantLocationId.set('');
    this.grantOrgId.set(orgId ?? '');
    this.grantError.set(null);
    this.showGrantModal.set(true);
  }

  closeGrant(): void {
    this.showGrantModal.set(false);
  }

  /**
   * Grants every newly-selected role in one submit — the backend only takes
   * one role per call, so this fires them off in sequence. Roles that were
   * already held for this exact scope are skipped rather than re-sent (see
   * existingRolesForTarget). On a partial failure the modal stays open and
   * grantRoles keeps its selection: reload() has by then refreshed
   * existingRolesForTarget with whatever DID succeed, so submitting again
   * only retries the roles that actually failed.
   */
  async submitGrant(): Promise<void> {
    const userId = this.grantUserId().trim();
    if (!userId) {
      this.grantError.set('Select a user.');
      return;
    }
    if (this.grantScope() === 'location' && !this.grantLocationId()) {
      this.grantError.set('Select a location.');
      return;
    }
    if (this.grantScope() === 'org' && !this.grantOrgId().trim()) {
      this.grantError.set('Select an organisation.');
      return;
    }
    const rolesToGrant = Array.from(this.grantRoles()).filter((r) => !this.existingRolesForTarget().has(r));
    if (rolesToGrant.length === 0) {
      this.grantError.set('Select at least one role that isn\'t already granted.');
      return;
    }

    this.granting.set(true);
    this.grantError.set(null);
    const failures: string[] = [];
    for (const role of rolesToGrant) {
      try {
        await this.stockAccess.locationAccessGrant({
          user_id: userId,
          role,
          scope: this.grantScope(),
          location_id: this.grantScope() === 'location' ? this.grantLocationId() : null,
          org_id: this.grantScope() === 'org' ? this.grantOrgId().trim() : null,
        });
      } catch (err: any) {
        console.error('[StockAccessPanel] grant failed for role', role, err);
        failures.push(`${role} (${err?.response?.data?.detail ?? err?.message ?? 'failed'})`);
      }
    }
    await this.load();
    this.granting.set(false);
    if (failures.length > 0) {
      this.grantError.set(`Could not grant: ${failures.join(', ')}. The rest were saved — submit again to retry.`);
      return;
    }
    this.showGrantModal.set(false);
  }

  async revokeGrant(g: LocationAccessGrant): Promise<void> {
    this.revoking.set(g.global_id);
    try {
      await this.stockAccess.locationAccessRevoke(g.global_id);
      this.grants.update((list) => list.filter((x) => x.global_id !== g.global_id));
    } catch (err: any) {
      console.error('[StockAccessPanel] revoke failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke access');
    } finally {
      this.revoking.set(null);
    }
  }
}
