import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { StockAccessApiService } from '../../services/stock-access-api.service';
import { RolesApiService } from '../../services/roles-api.service';
import { SessionService } from '../../session/session.service';
import { AccessRole, LocationAccessGrant, StockLocation } from '../../services/stock-access.types';
import { ClientPrivilege, ClientRole, UserRoleAssignment } from '../../services/roles.types';

/**
 * Roles carrying more than read access. Worth surfacing separately from a raw
 * grant count — the admin question is never "how many grants" but "who can
 * change things".
 */
const ELEVATED: ReadonlySet<AccessRole> = new Set<AccessRole>(['controller', 'auditor', 'custodian']);

const ALL_ROLES: AccessRole[] = ['viewer', 'operator', 'receiver', 'custodian', 'controller', 'auditor'];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private readonly stockAccess = inject(StockAccessApiService);
  private readonly rolesApi = inject(RolesApiService);
  readonly session = inject(SessionService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly locations = signal<StockLocation[]>([]);
  readonly grants = signal<LocationAccessGrant[]>([]);
  readonly roles = signal<ClientRole[]>([]);
  readonly privileges = signal<ClientPrivilege[]>([]);
  readonly assignments = signal<UserRoleAssignment[]>([]);

  // ─── Headline counters ──────────────────────────────────────────────────

  readonly distinctUsers = computed(() => new Set(this.grants().map((g) => g.user_id)).size);

  /** scope='client' reaches every location, present and future — the widest grant available. */
  readonly clientWide = computed(() => this.grants().filter((g) => g.scope === 'client'));
  readonly orgWide = computed(() => this.grants().filter((g) => g.scope === 'org'));
  readonly elevated = computed(() => this.grants().filter((g) => ELEVATED.has(g.role)));

  /** Locations nobody holds a location-scoped grant on. Org/client grants may still reach them. */
  readonly ungrantedLocations = computed(() => {
    const covered = new Set(
      this.grants().filter((g) => g.scope === 'location' && g.location_id).map((g) => g.location_id!),
    );
    return this.locations().filter((l) => !covered.has(l.global_id));
  });

  /** Grants per role, biggest first, zero-count roles dropped. */
  readonly byRole = computed(() => {
    const counts = new Map<AccessRole, number>();
    for (const g of this.grants()) counts.set(g.role, (counts.get(g.role) ?? 0) + 1);
    return ALL_ROLES
      .map((role) => ({ role, count: counts.get(role) ?? 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
  });

  /** Widest bar in the by-role list, so bars scale to the data rather than to a fixed max. */
  readonly maxRoleCount = computed(() => Math.max(1, ...this.byRole().map((r) => r.count)));

  readonly recentAssignments = computed(() =>
    [...this.assignments()]
      .sort((a, b) => String(b.assigned_date ?? '').localeCompare(String(a.assigned_date ?? '')))
      .slice(0, 8),
  );

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      // Independent calls — one slow endpoint shouldn't serialise the rest.
      const [locRes, grantRes, roleRes, privRes, assignRes] = await Promise.all([
        this.stockAccess.locationsList(),
        this.stockAccess.locationAccessList(),
        this.rolesApi.rolesList(),
        this.rolesApi.privilegesList(),
        this.rolesApi.userRolesList(null),
      ]);
      this.locations.set(locRes?.locations ?? []);
      this.grants.set(grantRes?.access ?? []);
      this.roles.set(roleRes?.roles ?? []);
      this.privileges.set(privRes?.privileges ?? []);
      this.assignments.set(assignRes?.assignments ?? []);
    } catch (err: any) {
      console.error('[Dashboard] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load access overview');
    } finally {
      this.loading.set(false);
    }
  }

  locationName(id: string | null): string {
    if (!id) return '—';
    return this.locations().find((l) => l.global_id === id)?.name ?? id.slice(0, 8);
  }

  barWidth(count: number): string {
    return `${Math.round((count / this.maxRoleCount()) * 100)}%`;
  }
}
