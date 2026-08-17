import { Injectable, inject } from '@angular/core';
import axios, { AxiosInstance } from 'axios';
import { SessionService } from '../session/session.service';
import { environment } from '../../environments/environment';
import { ModuleAccessEntry, ModuleAccessLevel, ModuleSummary, UserModuleAccess } from './modules-access.types';

/**
 * Wraps the `/modules/*` + `/modules/access/*` endpoints this app needs to
 * manage per-module access. Same GIS API backend CES_MODULES itself uses
 * (gis-api.onrender.com here vs. gis-api.corelinegis.com there — confirmed
 * 2026-08-17 to be the same service via identical validation-error bodies),
 * so a grant made here is immediately visible inside Modules.
 *
 * Access here is gated per-module by the caller's own role — a grant/list
 * call on a module the signed-in user doesn't manage (and isn't a GIS
 * System Manager on) will 403 server-side, same as it does inside Modules'
 * own access panel. `userModules()` is how this app determines which
 * modules to even offer for management.
 */
@Injectable({ providedIn: 'root' })
export class ModulesAccessApiService {
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
      console.warn('[ModulesAccessAPI] No session_gid available for request:', path);
    }
    const payload = { session_gid: gid, ...body };
    const { data } = await this.http.post(path, payload);
    return data as T;
  }

  /** All modules — same unfiltered list the module-landing page enumerates. */
  moduleList() {
    return this.post<{ response: string; modules: ModuleSummary[] } | ModuleSummary[]>('/modules/list');
  }

  /** The signed-in user's own access-level per module, incl. the System Manager bypass. */
  userModules() {
    return this.post<{ response: string; modules: UserModuleAccess[] } | UserModuleAccess[]>('/modules/access/user-modules');
  }

  /** Users with access to one module. Manager-of-that-module only, server-enforced. */
  accessList(module_gid: string) {
    return this.post<{ response: string; access: ModuleAccessEntry[] } | ModuleAccessEntry[]>('/modules/access/list', { module_gid });
  }

  /** Idempotent upsert — also how you change an existing user's role. */
  accessGrant(module_gid: string, user_email: string, access_level: ModuleAccessLevel) {
    return this.post<{ response: string }>('/modules/access/grant', { module_gid, user_email, access_level });
  }

  accessRevoke(module_gid: string, user_email: string) {
    return this.post<{ response: string }>('/modules/access/revoke', { module_gid, user_email });
  }
}
