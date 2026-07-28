import { Injectable, inject } from '@angular/core';
import axios, { AxiosInstance } from 'axios';
import { SessionService } from '../session/session.service';
import { environment } from '../../environments/environment';
import { LocationAccessGrant, LocationAccessGrantPayload, StockLocation } from './stock-access.types';

/**
 * Wraps the `/stock/locations/*` endpoints this app needs for location
 * access grants (org/location/client-scoped viewer/operator/controller/
 * auditor roles). Same GIS API as CES_STOCK_MANAGER's StockApiService —
 * only the access-management slice, since that's what lives here per the
 * "CES_USER_ACCESS_CONTROL is the sole access-control admin surface"
 * decision (2026-07-27).
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

  locationsList(filters?: { org_id?: string | null }) {
    return this.post<{ response: string; locations: StockLocation[] }>('/stock/locations/list', {
      org_id: filters?.org_id ?? null,
      location_type: null,
      status: null,
    });
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
}
