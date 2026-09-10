import { Injectable, inject } from '@angular/core';
import axios, { AxiosInstance } from 'axios';
import { SessionService } from '../session/session.service';
import { environment } from '../../environments/environment';
import { GeoPoint, LocationAccessGrant, LocationAccessGrantPayload, LocationCreatePayload, LocationStatus, LocationType, OrgCreatePayload, OrgRow, StockLocation } from './stock-access.types';
import { scrubTechnicalIds } from './error-scrub.util';

/** Ported verbatim from CES_STOCK_MANAGER's stock-api.service.ts so both
 *  apps read a location's pin identically. `/stock/locations/list` returns
 *  the point either as `geom` or as a stringified GeoJSON in `geom_json`,
 *  and sometimes as a raw string — this coerces all of that to a validated
 *  { type:'Point', coordinates:[lon,lat] } or null. UAC previously read
 *  `res.locations` raw, so a location whose geom came back as a string (or
 *  under geom_json) showed no pin. */
function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function resolveLocationGeom(raw: any): GeoPoint | null {
  const candidate = raw?.geom_json ?? raw?.geom;
  if (!candidate) return null;
  const parsed = typeof candidate === 'string' ? tryParseJson(candidate) : candidate;
  if (parsed?.type === 'Point' && Array.isArray(parsed?.coordinates) && parsed.coordinates.length === 2) {
    const [lon, lat] = parsed.coordinates;
    if (typeof lon === 'number' && typeof lat === 'number') {
      return { type: 'Point', coordinates: [lon, lat] };
    }
  }
  return null;
}

function normalizeLocation(raw: any): StockLocation {
  return { ...raw, geom: resolveLocationGeom(raw) };
}

/**
 * Wraps the `/stock/locations/*` and `/stock/orgs/*` endpoints this app
 * needs — location access grants (org/location/client-scoped viewer/
 * operator/controller/auditor roles), plus creating the orgs and locations
 * those grants attach to. Same GIS API as CES_STOCK_MANAGER's
 * StockApiService — access management plus the create flows an admin
 * setting up a brand-new org needs end-to-end, since that's what lives
 * here per the "CES_USER_ACCESS_CONTROL is the sole access-control admin
 * surface" decision (2026-07-27). Doesn't wrap locationUpdate or the
 * broader stock/item/balance endpoints — those stay Stock Manager's.
 */
@Injectable({ providedIn: 'root' })
export class StockAccessApiService {
  private readonly session = inject(SessionService);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: environment.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.http.interceptors.response.use(
      (res) => res,
      (error) => {
        if (typeof error?.response?.data?.detail === 'string') {
          error.response.data.detail = scrubTechnicalIds(error.response.data.detail);
        }
        if (typeof error?.message === 'string') {
          error.message = scrubTechnicalIds(error.message);
        }
        return Promise.reject(error);
      },
    );
  }

  private get sessionGid(): string {
    return this.session.session()?.session_gid ?? this.session.readCookie('session_gid') ?? '';
  }

  private async post<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
    const gid = this.sessionGid;
    if (!gid) {
      console.warn('[StockAccessAPI] No session_gid available for request:', path);
    }
    const payload = { session_gid: gid, ...body };
    const { data } = await this.http.post(path, payload);
    return data as T;
  }

  async locationsList(filters?: { org_id?: string | null; location_type?: LocationType | null; status?: LocationStatus | null }) {
    const res = await this.post<{ response: string; locations: any[] }>('/stock/locations/list', {
      org_id: filters?.org_id ?? null,
      location_type: filters?.location_type ?? null,
      status: filters?.status ?? null,
    });
    // Same normalisation CES_STOCK_MANAGER applies — coerce every row's geom.
    return { ...res, locations: (res?.locations ?? []).map(normalizeLocation) } as { response: string; locations: StockLocation[] };
  }

  locationCreate(payload: LocationCreatePayload) {
    return this.post<{ response: string; location_id: string }>('/stock/locations/create', payload);
  }

  locationAccessGrant(payload: LocationAccessGrantPayload) {
    return this.post<{ response: string; access_id: string }>('/stock/locations/access/grant', payload);
  }

  locationAccessRevoke(access_id: string) {
    return this.post<{ response: string }>('/stock/locations/access/revoke', { access_id });
  }

  locationAccessList(filters?: { location_id?: string | null; org_id?: string | null }) {
    return this.post<{ response: string; access: LocationAccessGrant[] }>('/stock/locations/access/list', {
      location_id: filters?.location_id ?? null,
      org_id: filters?.org_id ?? null,
    });
  }

  /**
   * Real user directory for a database (GIS API `/admin/db-users`) — the
   * same endpoint and shape CES_STOCK_MANAGER's ReferenceDataService uses
   * for its email pickers. `org_id` in this schema is currently a client
   * database gid (see the flagged organisation-identity gap), so this
   * doubles as "users who can be granted access under this org" until a
   * real org directory exists.
   */
  dbUsersList(db_gid: string) {
    return this.post<any>('/admin/db-users', { db_gid });
  }

  // ─── Organisations ────────────────────────────────────────────────────────
  // Confirmed live — the real org directory this app is the sole admin
  // surface for (org_id used everywhere in this schema is a client_db_gid;
  // this is what finally gives those ids a real name).

  orgCreate(payload: OrgCreatePayload) {
    return this.post<{ response: string; org_id?: string; data?: unknown }>('/stock/orgs/create', payload);
  }

  orgsList() {
    return this.post<{ response: string; orgs: OrgRow[] }>('/stock/orgs/list', {});
  }

  /** GIS projects (same GIS API, same endpoint Stock Manager's
   *  ReferenceDataService.loadProjects() uses) — candidate source for a
   *  stockpile location's project_id. Each entry carries a `global_id`
   *  (UUID) alongside the legacy numeric `project_id`; the UUID is what
   *  stock.locations.project_id actually stores. */
  projectsAll() {
    return this.post<{ response: string; project_list: any[] }>('/admin/projects/all', {});
  }
}
