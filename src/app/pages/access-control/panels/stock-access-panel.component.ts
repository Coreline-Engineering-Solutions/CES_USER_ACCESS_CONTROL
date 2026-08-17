import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StockAccessApiService } from '../../../services/stock-access-api.service';
import { SessionService } from '../../../session/session.service';
import { AccessRole, AccessScope, LocationAccessGrant, StockLocation } from '../../../services/stock-access.types';

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
    } catch (err: any) {
      console.error('[StockAccessPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load stock access data');
    } finally {
      this.loading.set(false);
    }
  }

  locationName(id: string | null): string {
    if (!id) return '—';
    return this.locations().find((l) => l.global_id === id)?.name ?? id.slice(0, 8);
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
      this.grantError.set('User ID is required.');
      return;
    }
    if (this.grantScope() === 'location' && !this.grantLocationId()) {
      this.grantError.set('Select a location.');
      return;
    }
    if (this.grantScope() === 'org' && !this.grantOrgId().trim()) {
      this.grantError.set('Organisation ID is required.');
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
