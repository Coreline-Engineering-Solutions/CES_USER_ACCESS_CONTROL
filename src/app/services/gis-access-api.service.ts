import { Injectable, inject } from '@angular/core';
import axios, { AxiosInstance } from 'axios';
import { SessionService } from '../session/session.service';
import { environment } from '../../environments/environment';
import { GisProject, GisProjectAssignResult } from './gis-access.types';

/**
 * Wraps the `/admin/projects/*` + `/admin/user-projects` endpoints —
 * CES_NG_GIS's project-membership surface. Confirmed live 2026-08-18: same
 * backend as Stock/Modules (gis-api.onrender.com == gis-api.corelinegis.com,
 * CES_NG_GIS's own default host).
 *
 * Binary membership only, no role tiers — a user either has a project or
 * doesn't. Gated entirely by GIS System Manager (`session.isSystemManager()`)
 * in CES_NG_GIS itself (menu-bar.component.html: `Project Access` only
 * renders for `isGisSystemManager()`); there is no per-project manager tier
 * the way Modules has, so the panel gates the same way Stock does — one
 * global flag, not "already holds a role here."
 *
 * `/admin/projects/assign` and `/admin/projects/remove` key on project
 * NAME as a string, not the numeric `project_id` — confirmed live: sending
 * the id as a number 422s ("Input should be a valid string"), and this
 * database's projects have no `project_gid` at all (pre-GID-migration, per
 * CES_NG_GIS's own client comments). Name-based is the case this adapter
 * has to handle correctly, not the exception.
 */
@Injectable({ providedIn: 'root' })
export class GisAccessApiService {
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
      console.warn('[GisAccessAPI] No session_gid available for request:', path);
    }
    const payload = { session_gid: gid, ...body };
    const { data } = await this.http.post(path, payload);
    return data as T;
  }

  /** Every project, admin view. Normalised to { project_id, name, description }. */
  async projectsAll(): Promise<GisProject[]> {
    const res: any = await this.post('/admin/projects/all', {});
    const list = res?.project_list ?? [];
    return list.map((p: any) => ({
      project_id: p.project_id,
      name: p.name ?? p.project_name ?? '',
      description: p.description ?? p.project_description ?? '',
    }));
  }

  /** One user's assigned projects. Same normalisation as projectsAll(). */
  async userProjects(email: string): Promise<GisProject[]> {
    const res: any = await this.post('/admin/user-projects', { email });
    const list = res?.project_list ?? [];
    return list.map((p: any) => ({
      project_id: p.project_id,
      name: p.name ?? p.project_name ?? '',
      description: p.description ?? p.project_description ?? '',
    }));
  }

  /** Assign by project NAME (see class doc) — idempotent-ish, safe to call for an already-held project. */
  assignProjects(email: string, projectNames: string[]) {
    return this.post<{ response: string } & Partial<GisProjectAssignResult>>('/admin/projects/assign', {
      email,
      projects: projectNames,
    });
  }

  /** Remove by project NAME. */
  removeProject(email: string, projectName: string) {
    return this.post<{ response: string }>('/admin/projects/remove', { email, project: projectName });
  }
}
