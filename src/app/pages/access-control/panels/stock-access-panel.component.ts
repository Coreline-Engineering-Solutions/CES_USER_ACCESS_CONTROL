import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { SessionService } from '../../../session/session.service';
import { AccessRole, AccessScope, LocationAccessGrant, StockLocation, StockUserRef } from '../../../services/stock-access.types';

/** One user, plus every grant they currently hold in this project. */
interface UserGrantGroup {
  user_id: string;
  email: string;
  grants: LocationAccessGrant[];
}

/**
 * Cosmetic-only label override for `org_id` — matches CES_STOCK_MANAGER's
 * ReferenceDataService.orgName() exactly (same org_ids, same labels), so an
 * admin sees the same name here as the stock team sees in their own app.
 * `org_id` today is actually a client database gid, not a real subcontractor
 * org — see the flagged organisation-identity gap in the activity tracker.
 * Never falls back to a real database/client name; unmapped org_ids get a
 * generic "Demo Org …" label instead.
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
  imports: [FormsModule],
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

  readonly showGrantModal = signal(false);
  readonly granting = signal(false);
  readonly grantError = signal<string | null>(null);
  readonly grantUserId = signal('');
  readonly grantRole = signal<AccessRole>('viewer');
  readonly grantScope = signal<AccessScope>('location');
  readonly grantLocationId = signal('');
  readonly grantOrgId = signal('');

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
    return ORG_LABEL_OVERRIDES[org_id] ?? `Demo Org ${org_id.slice(0, 6)}`;
  }

  openGrant(orgId?: string): void {
    this.grantUserId.set('');
    this.grantRole.set('viewer');
    this.grantScope.set(orgId ? 'org' : 'location');
    this.grantLocationId.set('');
    this.grantOrgId.set(orgId ?? '');
    this.grantError.set(null);
    this.showGrantModal.set(true);
  }

  closeGrant(): void {
    this.showGrantModal.set(false);
  }

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

    this.granting.set(true);
    this.grantError.set(null);
    try {
      await this.stockAccess.locationAccessGrant({
        user_id: userId,
        role: this.grantRole(),
        scope: this.grantScope(),
        location_id: this.grantScope() === 'location' ? this.grantLocationId() : null,
        org_id: this.grantScope() === 'org' ? this.grantOrgId().trim() : null,
      });
      this.showGrantModal.set(false);
      await this.load();
    } catch (err: any) {
      console.error('[StockAccessPanel] grant failed:', err);
      this.grantError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to grant access');
    } finally {
      this.granting.set(false);
    }
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
