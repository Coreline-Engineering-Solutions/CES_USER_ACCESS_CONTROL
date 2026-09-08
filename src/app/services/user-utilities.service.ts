import { Injectable, inject, signal, computed } from '@angular/core';
import { SessionService } from '../session/session.service';

/** Normalised comparison key. The auth API is inconsistent about separators —
 *  the same utility comes back as "User Access Control" and
 *  "User_Access_Control" depending on the caller — so nothing in here compares
 *  utility names raw. CES_WEB's dashboard normalises for the same reason. */
export function utilityKey(v: unknown): string {
  return String(v ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function nameOf(entry: any): string {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.utility_name ?? entry?.name ?? '').trim();
}

/**
 * Toolset (utility) assignment — the thing that actually puts a tool on a
 * user's CES_WEB dashboard.
 *
 * Why this exists: granting someone module/stock/GIS access from the Projects
 * tab gives them permission INSIDE a tool, but it does not give them the tool.
 * The dashboard builds its tile list from the auth API's `utility_list`
 * (admin.utility_access), so without a utility row the user has been granted
 * access to something they cannot see or reach. This closes that gap, using
 * the same four auth functions CES_ACCESS_CONTROL already uses.
 *
 * THE SCOPING RULE — `assignable` is the point of this service:
 *
 *   A manager may only hand out toolsets they hold themselves.
 *
 * `_available_utilities` returns every utility on the platform, so offering it
 * raw would let any client's manager grant tools their company has nothing to
 * do with. `assignable` intersects it with the caller's own access list, so
 * the dropdown can only ever contain tools the manager already has. GIS System
 * Managers are the deliberate exception and see the full list, matching the
 * bypass they already get everywhere else.
 *
 * The users being granted to are separately confined to the ACTIVE database by
 * DbUsersService (auth membership decides), so a manager cannot reach another
 * company's users either.
 */
@Injectable({ providedIn: 'root' })
export class UserUtilitiesService {
  private readonly session = inject(SessionService);
  private readonly AUTH_API = 'https://auth-api-frankfurt.onrender.com/auth';

  /** Every utility the platform knows about (unfiltered). */
  readonly available = signal<string[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Utilities the SIGNED-IN manager holds — the ceiling on what they can grant. */
  readonly mine = computed<string[]>(() =>
    (this.session.accessList() ?? []).map(nameOf).filter(Boolean),
  );

  /**
   * What this manager may actually assign: everything they hold themselves,
   * intersected with what exists. System Managers get the full list.
   */
  readonly assignable = computed<string[]>(() => {
    const all = this.available();
    if (this.session.isSystemManager()) return all;

    const mineKeys = new Set(this.mine().map(utilityKey));
    if (mineKeys.size === 0) return [];
    // Prefer the platform's spelling where we have it, so what we send back
    // matches what the API expects.
    const matched = all.filter((u) => mineKeys.has(utilityKey(u)));
    // If `_available_utilities` failed or returned nothing, fall back to the
    // manager's own names rather than showing an empty dropdown — they are
    // valid utility names by definition.
    return matched.length > 0 ? matched : this.mine();
  });

  private get sessionGid(): string {
    return this.session.session()?.session_gid ?? this.session.readCookie('session_gid') ?? '';
  }

  private async call(body: Record<string, any>): Promise<any> {
    const session_gid = this.sessionGid;
    if (!session_gid) throw new Error('No active session');
    const res = await fetch(this.AUTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_gid, ...body }),
    });
    const raw = await res.json().catch(() => null);
    return typeof raw === 'string' ? safeParse(raw) : raw;
  }

  private static succeeded(data: any): boolean {
    if (data === true) return true;
    const r = data?.response ?? data;
    if (typeof r === 'string') return r.trim().toUpperCase().startsWith('_S');
    return false;
  }

  async loadAvailable(): Promise<void> {
    if (this.available().length > 0) return; // platform-wide list — fetch once
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.call({ function: '_available_utilities' });
      const list: any[] = data?.utility_list ?? [];
      this.available.set(list.map(nameOf).filter(Boolean));
    } catch (e: any) {
      this.error.set(e?.message ?? 'Could not load the toolset list');
      this.available.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** Utilities currently granted to one user. */
  async utilitiesFor(email: string): Promise<string[]> {
    if (!email) return [];
    const data = await this.call({ function: '_check_user_utilities', email });
    const list: any[] = data?.utility_list ?? [];
    return list.map(nameOf).filter(Boolean);
  }

  /**
   * Grant a toolset. Refuses anything outside `assignable` — the dropdown
   * already filters, but a UI-only check is not a boundary, and this is the
   * call that actually widens someone's access.
   */
  async assign(email: string, utility: string): Promise<boolean> {
    if (!email || !utility) return false;
    if (!this.canAssign(utility)) {
      throw new Error(`You can only grant toolsets you hold yourself (${utility} is not one of them).`);
    }
    const data = await this.call({ function: '_assign_user_utility', email, utility });
    return UserUtilitiesService.succeeded(data);
  }

  /** Revoke a toolset. Same ceiling as assign. */
  async remove(email: string, utility: string): Promise<boolean> {
    if (!email || !utility) return false;
    if (!this.canAssign(utility)) {
      throw new Error(`You can only revoke toolsets you hold yourself (${utility} is not one of them).`);
    }
    const data = await this.call({ function: '_remove_user_utility', email, utility });
    return UserUtilitiesService.succeeded(data);
  }

  canAssign(utility: string): boolean {
    if (this.session.isSystemManager()) return true;
    const k = utilityKey(utility);
    return this.assignable().some((u) => utilityKey(u) === k);
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}
