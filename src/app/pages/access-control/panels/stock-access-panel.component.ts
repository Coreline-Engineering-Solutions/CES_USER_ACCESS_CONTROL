import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TitleCasePipe } from '@angular/common';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { SessionService } from '../../../session/session.service';
import { AccessRole, AccessScope, LocationAccessGrant, LocationType, OrgRow, StockLocation, StockUserRef } from '../../../services/stock-access.types';

/** One user, plus every grant they currently hold in this project. */
interface UserGrantGroup {
  user_id: string;
  email: string;
  grants: LocationAccessGrant[];
}

/** Per-org outcome of loadUsers()'s three-source lookup, shown directly in
 *  the Grant modal's empty state — surfacing this in the UI instead of only
 *  the console, since relaying console output back and forth is slow.
 *  gis/auth are either a count ("3") or "error: <detail>". */
interface UsersDebugRow {
  orgId: string;
  orgLabel: string;
  gis: string;
  auth: string;
  nameFallback?: string;
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
  /** Per-org breakdown of loadUsers()'s three lookup sources — shown in the
   *  Grant modal when users() is empty, so what's actually failing is
   *  visible right there instead of needing console output relayed back. */
  readonly usersDebug = signal<UsersDebugRow[]>([]);
  /** Count/error for the system-wide catch-all (session.listAllUsers), '?'
   *  while loading. Shown next to usersDebug's per-org breakdown. */
  readonly usersDebugGlobal = signal<string>('?');
  /** Raw JSON of the first non-string user object seen across any source,
   *  so a field-name mismatch in the id lookup is visible directly in the
   *  UI. Empty string until loadUsers() finds one. */
  readonly usersRawSample = signal<string>('');
  /** Real UUID, not an email masquerading as one — loadUsers()'s merge
   *  falls back to the email itself as a StockUserRef's user_gid when none
   *  of the three lookup sources had a real id, so the entry still shows
   *  up and is still readable in Users & their access. That's fine for
   *  DISPLAY, but confirmed live to break hard the moment that value is
   *  actually submitted as a UUID column (custodian_user_id, grantUserId):
   *  "invalid input for query argument $5: 'gustavhunsinger@gmail.com'".
   *  Every dropdown that SUBMITS a user_gid must filter through this. */
  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Union of every org's db-linked users, deduped by email — the actual
   *  picker source for Grant's User field below. Deliberately narrower than
   *  users() (which folds in session.listAllUsers(), a genuinely
   *  system-wide, cross-client directory) — 2 Sep: Grant's picker must only
   *  offer users linked to a db this admin can already see, never "anyone
   *  registered anywhere," per explicit direction repeated throughout this
   *  session. The manual-entry escape hatch (grantUserManualEntry) still
   *  covers granting to someone not yet linked to any org on file — that
   *  was the actual reason the system-wide fold-in got added in the first
   *  place, and manual entry covers it without needing to show the whole
   *  system's users to do it. */
  readonly dbLinkedUsers = computed<StockUserRef[]>(() => {
    const byEmail = new Map<string, StockUserRef>();
    for (const list of this.usersByOrg().values()) {
      for (const u of list) {
        const key = u.email.toLowerCase();
        const existing = byEmail.get(key);
        if (!existing || (u.user_gid && u.user_gid !== u.email && existing.user_gid === existing.email)) {
          byEmail.set(key, u);
        }
      }
    }
    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
  });

  readonly pickableUsers = computed(() => this.dbLinkedUsers().filter((u) => StockAccessPanelComponent.UUID_RE.test(u.user_gid)));

  /** Per-org membership, built alongside users() by loadUsers() from the
   *  SAME per-org gis+auth+nameFallback lookups but WITHOUT the system-wide
   *  listAllUsers() catch-all folded in — both the location-create
   *  Custodian field AND Grant's User field (via dbLinkedUsers() above,
   *  which unions this map) must only offer people actually linked to a
   *  db this admin can see. Keyed by org_id (== client db gid), same key
   *  locDraftOrgId() holds. */
  readonly usersByOrg = signal<Map<string, StockUserRef[]>>(new Map());
  /** Custodian dropdown source for the location-create modal — just the
   *  users linked to whichever org locDraftOrgId() currently holds, not the
   *  full system-wide users() list. */
  readonly locDraftOrgUsers = computed(() => this.usersByOrg().get(this.locDraftOrgId()) ?? []);

  // ─── GIS projects (stockpile location's project field) ──────────────────
  // Same GIS API, same /admin/projects/all endpoint, same shape Stock
  // Manager's ReferenceDataService.loadProjects()/pickableProjects() use —
  // ported here so the New location modal's stockpile Project field can be
  // a real dropdown instead of a manual UUID paste.
  readonly projects = signal<{ global_id: string; project_id: number; name: string }[]>([]);
  /** Every named project shows up here now, not just ones with a resolved
   *  UUID — 2 Sep: hiding pre-migration projects entirely was worse than the
   *  submission risk (see pickableProjectId() below), since an account
   *  whose projects simply hadn't been backfilled yet saw "no projects" and
   *  had to paste a raw UUID by hand for a project it could plainly see the
   *  name of. Mirrors CES_STOCK_MANAGER's ReferenceDataService.pickableProjects()
   *  — keep the two in sync. Sorted by name. */
  readonly pickableProjects = computed(() =>
    this.projects()
      .filter((p) => p.name.length > 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** The value to actually submit/track for a project row — prefer the real
   *  UUID, fall back to the legacy numeric id (stringified) when the backend
   *  hasn't backfilled global_id for this project yet.
   *
   *  The numeric fallback is DISPLAY/DEDUP only — confirmed live 2 Sep,
   *  submitting it as stock.locations.project_id throws a raw Postgres
   *  error server-side ("invalid UUID '5': length must be between 32..36
   *  characters, got 1"). Every caller that SUBMITS this value must gate on
   *  hasRealProjectId() first — see the Project field guard in
   *  submitCreateLocation(). Mirrors CES_STOCK_MANAGER's identical fix, keep
   *  the two in sync. */
  pickableProjectId(p: { global_id: string; project_id: number }): string {
    return p.global_id || String(p.project_id);
  }

  /** True when a project row carries a real UUID and is therefore actually
   *  submittable — see pickableProjectId()'s doc comment. */
  hasRealProjectId(p: { global_id: string; project_id: number }): boolean {
    return StockAccessPanelComponent.UUID_RE.test(p.global_id);
  }

  /** Raw-vs-pickable breakdown for /admin/projects/all, shown in the New
   *  location modal's empty state when pickableProjects() is empty — same
   *  reasoning as usersDebug: a raw fetch count that doesn't match the
   *  pickable count usually means real projects came back but without a
   *  global_id yet (pre-migration rows — see pickableProjects' doc
   *  comment), not that the fetch itself failed. */
  readonly projectsDebug = signal<string>('?');
  /** Raw JSON of the first project object seen — same reasoning as
   *  usersRawSample, for the same "is this an id-field-name mismatch or a
   *  genuine pre-migration gap" question. */
  readonly projectsRawSample = signal<string>('');

  private async loadProjects(): Promise<void> {
    try {
      const res = await this.stockAccess.projectsAll();
      const raw = (res as any)?.project_list ?? (res as any)?.projects ?? [];
      const rawList = Array.isArray(raw) ? raw : [];
      if (rawList.length > 0) this.projectsRawSample.set(JSON.stringify(rawList[0]).slice(0, 300));
      const list = rawList.map((p: any) => ({
        // Widened on purpose — see loadUsers()'s usersRawSample comment for
        // why: a narrower match was silently missing whichever field name
        // this endpoint actually uses, showing "no projects" for accounts
        // that do have real, pickable projects.
        global_id: String(
          p?.global_id ?? p?.project_gid ?? p?.projectGid ?? p?.gid ?? p?.uuid ??
          p?.project_uuid ?? p?.projectUuid ?? p?.globalId ?? ''
        ).trim(),
        project_id: Number(p?.project_id ?? 0),
        name: String(p?.project_name ?? p?.name ?? p?.projectName ?? '').trim(),
      }));
      this.projects.set(list);
      const withGid = list.filter((p) => p.global_id).length;
      this.projectsDebug.set(`${rawList.length} project(s) returned, ${withGid} with a usable global_id`);
    } catch (err: any) {
      console.warn('[StockAccessPanel] projects lookup failed:', err);
      this.projectsDebug.set(`error: ${err?.response?.status ?? err?.message ?? err}`);
    }
  }

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

  /** Seeded from the real org directory FIRST, then location counts are
   *  overlaid on top — not built from locations() alone. A freshly
   *  registered org has zero locations yet, so building this from
   *  locations() only meant "Register org" appeared to silently do
   *  nothing: the org was created (confirmed live in realOrgs()/orgName())
   *  but never listed here until its first location showed up. realOrgs()
   *  is populated by loadRealOrgs(), which submitCreateOrg() already
   *  re-runs after a successful create, so this updates immediately. */
  readonly orgs = computed(() => {
    const map = new Map<string, { org_id: string; count: number; types: Set<string> }>();
    for (const o of this.realOrgs()) {
      map.set(o.client_db_gid, { org_id: o.client_db_gid, count: 0, types: new Set<string>() });
    }
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
  /** True while openCreateOrg() is fetching the active DB's gid — the modal
   *  shows a loading state on the ID field instead of an empty one, since
   *  it's no longer something the admin types themselves. */
  readonly orgDraftDbLoading = signal(false);

  /** org_id in this schema IS a client_db_gid (see the class doc comment
   *  above and stock-access.types.ts) — the org being registered here isn't
   *  a new database, it's a NAME for the database this admin session is
   *  currently pointed at. Making the admin hand-type that UUID was just an
   *  opportunity for a copy-paste mistake to register a name against the
   *  wrong client's data; fetch it straight from the session instead. */
  async openCreateOrg(): Promise<void> {
    this.orgDraftName.set('');
    this.orgDraftClientDbGid.set('');
    this.orgCreateError.set(null);
    this.showCreateOrgModal.set(true);
    this.orgDraftDbLoading.set(true);
    try {
      // Re-fetch rather than trusting navbar's earlier load — "currently in
      // use" should mean live-current, not whatever was true on page load.
      const db = await this.session.fetchCurrentDb();
      const dbGid = String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim();
      if (dbGid) {
        this.orgDraftClientDbGid.set(dbGid);
      } else {
        this.orgCreateError.set('Could not determine the active database — switch to a database first, then try again.');
      }
    } catch (err: any) {
      console.error('[StockAccessPanel] failed to fetch current DB for org create:', err);
      this.orgCreateError.set('Could not determine the active database — switch to a database first, then try again.');
    } finally {
      this.orgDraftDbLoading.set(false);
    }
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
      // A brand-new org has no locations yet, but its /admin/db-users
      // directory can already have people in it — refresh so the Grant
      // modal doesn't show "no users" for an org that was JUST registered.
      void this.loadUsers();
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

  // ─── Location creation ──────────────────────────────────────────────────
  // /stock/locations/create — same endpoint and payload Stock Manager's own
  // "New location" modal uses (see CES_STOCK_MANAGER's locations.component),
  // just not previously wired up in this app. Without this, an admin who
  // just registered a brand-new org (above) had to switch to Stock Manager
  // to give it anywhere to actually hold stock.
  readonly showCreateLocationModal = signal(false);
  readonly locDraftType = signal<LocationType>('warehouse');
  readonly locDraftName = signal('');
  readonly locDraftOrgId = signal('');
  /** Manual UUID entry, not a picker — this app has no GIS project data
   *  loaded (Stock Manager's own picker falls back the same way when its
   *  reference data hasn't loaded). Only relevant for the 'stockpile' type. */
  readonly locDraftProjectId = signal('');
  /** Only relevant for the 'bootstock' type. Picked from users() when
   *  available (already loaded per-org by loadUsers() above); falls back to
   *  a manual UUID field the same way the org picker does when empty. */
  readonly locDraftCustodianUserId = signal('');
  readonly locCreating = signal(false);
  readonly locCreateError = signal<string | null>(null);

  /** orgId pre-fills the organisation field when opened from a specific
   *  org's card — mirrors openGrant(orgId?) below. */
  openCreateLocation(orgId?: string): void {
    this.locDraftType.set('warehouse');
    this.locDraftName.set('');
    this.locDraftOrgId.set(orgId ?? (this.orgs().length === 1 ? this.orgs()[0].org_id : ''));
    this.locDraftProjectId.set('');
    this.locDraftCustodianUserId.set('');
    this.locCreateError.set(null);
    this.showCreateLocationModal.set(true);
  }

  closeCreateLocation(): void {
    this.showCreateLocationModal.set(false);
  }

  async submitCreateLocation(): Promise<void> {
    const name = this.locDraftName().trim();
    const orgId = this.locDraftOrgId().trim();
    const type = this.locDraftType();
    if (!name || !orgId) {
      this.locCreateError.set('Name and organisation are both required.');
      return;
    }
    if (type === 'stockpile') {
      const pid = this.locDraftProjectId().trim();
      if (!pid) {
        this.locCreateError.set('Stockpiles require a project.');
        return;
      }
      // Defence-in-depth: the dropdown already disables options without a
      // real UUID (see the template), but guard the submit too — see
      // pickableProjectId()'s doc comment for why the numeric fallback can
      // never be sent to the server.
      const proj = this.pickableProjects().find((p) => this.pickableProjectId(p) === pid);
      if (proj && !this.hasRealProjectId(proj)) {
        this.locCreateError.set(
          `"${proj.name}" hasn't been migrated to the new project ID system yet — ask backend to run the ` +
          'admin.projects.global_id backfill for this project before creating a stockpile against it.',
        );
        return;
      }
    }
    if (type === 'bootstock' && !this.locDraftCustodianUserId().trim()) {
      this.locCreateError.set('Bootstock requires a custodian user.');
      return;
    }
    this.locCreating.set(true);
    this.locCreateError.set(null);
    try {
      await this.stockAccess.locationCreate({
        org_id: orgId,
        name,
        location_type: type,
        project_id: type === 'stockpile' ? this.locDraftProjectId().trim() : null,
        custodian_user_id: type === 'bootstock' ? this.locDraftCustodianUserId().trim() : null,
      });
      this.showCreateLocationModal.set(false);
      // Lightweight refresh — just the locations list, not the whole panel
      // (matching submitCreateOrg()'s loadRealOrgs()-only refresh above).
      const locRes = await this.stockAccess.locationsList();
      this.locations.set(locRes?.locations ?? []);
    } catch (err: any) {
      console.error('[StockAccessPanel] location create failed:', err);
      this.locCreateError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to create location');
    } finally {
      this.locCreating.set(false);
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
  /** Toggles the User field between the picker and a manual UUID input —
   *  loadUsers() now merges three sources (see its own doc comment) to
   *  cover the case that motivated this in the first place, but a
   *  brand-new org/database's user directory may still not be synced yet
   *  (or the target user just isn't in it), and there was previously no
   *  way to grant access at all when that happened — the picker's empty
   *  state was a dead end. */
  readonly grantUserManualEntry = signal(false);
  /** Multi-select — a user can hold several roles on the same scope (e.g.
   *  Operator + Auditor on one location), and forcing one grant per modal
   *  visit meant re-opening this dialog for every extra role. */
  readonly grantRoles = signal<Set<AccessRole>>(new Set());
  readonly grantScope = signal<AccessScope>('location');
  readonly grantLocationId = signal('');
  readonly grantOrgId = signal('');

  /** The ONE org relevant to the grant currently being set up — 'org' scope
   *  uses grantOrgId directly, 'location' scope derives it from the
   *  selected location's own org_id. 'client' scope has no single org by
   *  definition (a client-wide grant is explicitly cross-org), so this
   *  returns '' for it — grantPickableUsers() below handles that case
   *  separately. */
  readonly grantEffectiveOrgId = computed<string>(() => {
    const scope = this.grantScope();
    if (scope === 'org') return this.grantOrgId().trim();
    if (scope === 'location') {
      const loc = this.locations().find((l) => l.global_id === this.grantLocationId());
      return loc?.org_id ?? '';
    }
    return '';
  });

  /** Grant's actual User picker source. Found live 2 Sep: dbLinkedUsers()
   *  (a union of EVERY org's users) doesn't fix "showing all users" for
   *  Stock the way it does for GIS/Modules' single-active-db dropdowns —
   *  this admin surface manages several client orgs from one session by
   *  design, so unioning every org's list back together just reassembles
   *  the same "everyone" problem from a different pipe. This scopes to the
   *  ONE org the grant is actually for, exactly like locDraftOrgUsers()
   *  already does for the Custodian field — 'client' scope is the one
   *  legitimately cross-org case (falls back to dbLinkedUsers(), still
   *  bounded to orgs this admin can act on, never the true system-wide
   *  listAllUsers() directory). */
  readonly grantPickableUsers = computed<StockUserRef[]>(() => {
    if (this.grantScope() === 'client') return this.pickableUsers();
    const orgId = this.grantEffectiveOrgId();
    if (!orgId) return [];
    return (this.usersByOrg().get(orgId) ?? []).filter((u) => StockAccessPanelComponent.UUID_RE.test(u.user_gid));
  });

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
      // loadRealOrgs() MUST resolve before loadUsers() runs — loadUsers()
      // reads orgs(), which is seeded from realOrgs(). Firing both
      // unawaited in parallel (the previous code) was the actual bug behind
      // "the picker's empty on open but Refresh fixes it": realOrgs() is []
      // until its own fetch resolves, so on first load orgs() was still
      // empty when loadUsers() read it, orgIds ended up [], and the whole
      // lookup bailed out via its own early return before ever calling any
      // of the three sources — Refresh worked purely because enough time
      // had passed by then for realOrgs() to have already resolved.
      await this.loadRealOrgs();
      void this.loadUsers();
      void this.loadProjects();
    } catch (err: any) {
      console.error('[StockAccessPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load stock access data');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Real, pickable users, per org_id currently in use (org_id == client
   * database gid today), merged and de-duped, so the grant form offers an
   * actual "who is this" list instead of asking an admin to type a UUID by
   * hand. Best-effort per org: one failing/empty org doesn't block others.
   *
   * Three sources, in priority order — confirmed live that the first alone
   * can come back empty for a real, populated database while the others
   * have the actual answer:
   *  1. StockAccessApiService.dbUsersList — GIS API's /admin/db-users.
   *  2. session.dbUsersList — central AUTH_API's /auth/db/users/list, the
   *     same call CES_ACCESS_CONTROL's databases-page uses as ITS primary
   *     "who's linked to this db" source (user-session.ts, same AUTH_API).
   *  3. session.checkDatabaseUsers — AC's own fallback for when #2 has
   *     nothing either, keyed by the database's real name (not this org's
   *     UAC-side label) resolved from session.databases() by gid.
   * AC's own downstream code only ever reads .email off these results —
   * never a gid — so unlike source #1 (which is a real GIS user object with
   * a user_gid), #2/#3 may only carry emails. Entries with no resolvable
   * gid keep the email itself as their id: locationAccessGrant's user_id
   * field already accepts an admin-typed arbitrary string via the existing
   * manual-entry fallback, so this isn't a new kind of value for it to see.
   */
  private async loadUsers(): Promise<void> {
    const orgIds = this.orgs().map((o) => o.org_id).filter(Boolean);
    if (orgIds.length === 0) return;
    this.usersLoading.set(true);
    this.usersDebugGlobal.set('?');
    try {
      // The name-based fallback below needs the database's real name, not
      // this app's own org label — session.databases() is what has that,
      // but it's only populated by the navbar's own independent ngOnInit.
      // Don't trust that race; fetch it ourselves if it hasn't landed yet.
      if (this.session.databases().length === 0) {
        await this.session.fetchDatabases().catch(() => {});
      }
      const dbNameByGid = new Map<string, string>(
        this.session.databases()
          .map((db: any): [string, string] => [
            String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim(),
            String(db?.name ?? db?.db_name ?? db?.description ?? '').trim(),
          ])
          .filter(([gid]) => !!gid),
      );

      const debugRows: UsersDebugRow[] = [];
      const perOrgLists = await Promise.all(
        orgIds.map(async (gid) => {
          const row: UsersDebugRow = { orgId: gid, orgLabel: this.orgName(gid), gis: '?', auth: '?' };
          debugRows.push(row);

          const [gisRes, authRes] = await Promise.all([
            this.stockAccess.dbUsersList(gid).catch((err) => {
              row.gis = `error: ${err?.response?.status ?? err?.message ?? err}`;
              return null;
            }),
            this.session.dbUsersList(gid).catch((err) => {
              row.auth = `error: ${err?.message ?? err}`;
              return [] as any[];
            }),
          ]);
          const gisListRaw = gisRes?.users ?? gisRes?.emails ?? gisRes?.email_list ?? gisRes?.user_list ?? gisRes?.data ?? gisRes;
          const gisList: any[] = Array.isArray(gisListRaw) ? gisListRaw : [];
          const authList: any[] = Array.isArray(authRes) ? authRes : [];
          if (row.gis === '?') row.gis = String(gisList.length);
          if (row.auth === '?') row.auth = String(authList.length);
          let combined: any[] = [...gisList, ...authList];
          if (combined.length === 0) {
            // Neither GIS-side nor the auth-api gid lookup found anyone —
            // last resort, by name, but ONLY when this gid is a CONFIRMED
            // real database (present in session.databases()). Found live
            // 2 Sep: the previous `|| this.orgName(gid)` fallback sent this
            // org's own Stock-side display LABEL to the name lookup whenever
            // its client_db_gid wasn't a database session.databases()
            // actually recognises — an unverified label has no guarantee of
            // matching only (or even loosely) the right database
            // server-side, and is the most plausible way a Custodian/Grant
            // picker for one specific org could end up showing people who
            // have nothing to do with it. Skip the lookup entirely in that
            // case instead of risking it.
            const dbName = dbNameByGid.get(gid);
            if (dbName) {
              const byName = await this.session.checkDatabaseUsers(dbName).catch((err) => {
                row.nameFallback = `"${dbName}" -> error: ${err?.message ?? err}`;
                return [] as any[];
              });
              combined = Array.isArray(byName) ? byName : [];
              if (!row.nameFallback) row.nameFallback = `"${dbName}" -> ${combined.length}`;
            } else {
              row.nameFallback = `skipped — "${gid}" is not a database session.databases() recognises (org label "${this.orgName(gid)}" is not a verified database name)`;
            }
          }
          return combined;
        }),
      );
      this.usersDebug.set(debugRows);

      // Per-org membership — built from EACH org's own combined list only
      // (no system-wide catch-all folded in), so the location-create
      // Custodian dropdown can offer just the people actually linked to
      // that org's db. See usersByOrg's own doc comment for why this is a
      // separate, narrower list from users()/pickableUsers() below.
      const orgUsersMap = new Map<string, StockUserRef[]>();
      orgIds.forEach((gid, i) => {
        orgUsersMap.set(gid, StockAccessPanelComponent.mergeUserLists([perOrgLists[i]]));
      });
      this.usersByOrg.set(orgUsersMap);

      // System-wide catch-all, fetched once (not per-org — this directory
      // isn't scoped to any one database). DISPLAY resolution only as of
      // 2 Sep — a grant's user_id can be a real, valid registered user who
      // simply never showed up in any of the three narrower "linked to THIS
      // db" lookups above, and without this, that grant would permanently
      // show as a bare UUID in Users & their access instead of an email.
      // It is NOT a picker source any more: dbLinkedUsers()/pickableUsers()
      // above are built from usersByOrg only, deliberately excluding this —
      // Grant's User field must only offer people linked to a db this admin
      // can see, never "anyone registered anywhere." Lowest priority in the
      // users() merge below (pushed last) for the same reason.
      const allUsers = await this.session.listAllUsers().catch((err) => {
        this.usersDebugGlobal.set(`error: ${err?.message ?? err}`);
        return [] as any[];
      });
      if (this.usersDebugGlobal() === '?') this.usersDebugGlobal.set(String(allUsers.length));

      // Raw shape of whatever the FIRST non-string entry we saw looked like,
      // across every source — shown in the UI (see the empty-state debug
      // block) so a field-name mismatch is visible directly instead of
      // needing console access. If pickableUsers() is still empty after a
      // widened id-field match below, this is the next thing to check.
      if (!this.usersRawSample()) {
        for (const list of [...perOrgLists, allUsers]) {
          const sample = Array.isArray(list) ? list.find((u) => typeof u === 'object' && u) : null;
          if (sample) { this.usersRawSample.set(JSON.stringify(sample).slice(0, 300)); break; }
        }
      }

      this.users.set(StockAccessPanelComponent.mergeUserLists([...perOrgLists, allUsers]));
    } finally {
      this.usersLoading.set(false);
    }
  }

  /** Shared merge/dedup used by both users() (global, all sources incl. the
   *  system-wide catch-all) and usersByOrg (per-org, narrower). Deduped by
   *  EMAIL (case-insensitive), not by id — the same person can legitimately
   *  show up from more than one source with different id shapes (a real gid
   *  from the GIS list, email-as-id from the auth-api one), and deduping by
   *  id would show them twice under two values instead of once. A real gid
   *  always wins over an email-fallback id if we see both for the same
   *  person. Sorted by email for stable dropdown/list ordering. */
  private static mergeUserLists(lists: any[][]): StockUserRef[] {
    const byEmail = new Map<string, StockUserRef>();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const u of list) {
        const isStr = typeof u === 'string';
        const email = String(isStr ? u : (u?.email ?? u?.user_email ?? u?.userEmail ?? '')).trim();
        // Widened on purpose — every plausible id-field spelling seen
        // across this codebase's various user-list endpoints, since a
        // narrower match was silently missing whichever one _list_users/
        // dbUsersList actually use and forcing manual UUID entry for
        // real, valid users. See usersRawSample above if this still
        // comes up empty after this.
        const realId = String(isStr ? '' : (
          u?.user_gid ?? u?.userGid ?? u?.gid ?? u?.uuid ?? u?.UUID ??
          u?.user_id ?? u?.userId ?? u?.id ?? u?.global_id ?? u?.globalId ?? ''
        )).trim();
        if (!email) continue;
        const key = email.toLowerCase();
        const existing = byEmail.get(key);
        // No real id available — fall back to the email itself so the
        // entry still shows up in Users & their access for DISPLAY, but
        // pickableUsers() below filters these back out of anything that
        // actually submits a value — an email here is not a valid
        // substitute UUID, confirmed live (Postgres rejects it outright).
        if (!existing) {
          byEmail.set(key, { user_gid: realId || email, email });
        } else if (realId && existing.user_gid === existing.email) {
          byEmail.set(key, { user_gid: realId, email });
        }
      }
    }
    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
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

  /** Grants that actually apply AT this org: org-scoped grants naming it
   *  directly, plus location-scoped grants whose location belongs to it.
   *  Deliberately excludes client-wide grants — those apply to every org at
   *  once, so folding them into one org's count would overstate that org's
   *  own access and understate the others'. */
  orgGrantCount(org_id: string): number {
    const locIds = new Set(this.locations().filter((l) => l.org_id === org_id).map((l) => l.global_id));
    return this.grants().filter((g) =>
      (g.scope === 'org' && g.org_id === org_id) ||
      (g.scope === 'location' && g.location_id != null && locIds.has(g.location_id))
    ).length;
  }

  /** "warehouse, stockpile, bootstock" — sorted for a stable display order,
   *  independent of Set insertion order (which follows location() array order). */
  orgTypesLabel(types: Set<string>): string {
    const order = ['warehouse', 'stockpile', 'bootstock'];
    return order.filter((t) => types.has(t)).join(', ') || '—';
  }

  openGrant(orgId?: string): void {
    this.grantUserId.set('');
    this.grantUserManualEntry.set(false);
    this.grantRoles.set(new Set());
    this.grantScope.set(orgId ? 'org' : 'location');
    this.grantLocationId.set('');
    this.grantOrgId.set(orgId ?? '');
    this.grantError.set(null);
    this.showGrantModal.set(true);
  }

  /** "Refresh" button on the Grant modal's empty-user-list state — re-runs
   *  loadUsers() without a full page reload, for right after registering
   *  an org/location whose user directory hadn't synced yet. */
  async refreshUsers(): Promise<void> {
    await this.loadUsers();
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
