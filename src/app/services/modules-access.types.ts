// Types matching CES_MODULES' `/modules/*` and `/modules/access/*` surface
// (see CES_MODULES/ces-modules/src/app/services/modules-api.service.ts and
// module-access.store.ts) — same backend as Stock Manager/UAC
// (gis-api.onrender.com and gis-api.corelinegis.com are the same service,
// confirmed 2026-08-17: identical validation errors on both hosts).

export type ModuleAccessLevel = 'manager' | 'contributor' | 'viewer';

export interface ModuleSummary {
  module_gid: string;
  description: string;
}

export interface ModuleAccessEntry {
  user_email: string;
  access_level: ModuleAccessLevel;
  granted_by?: string | null;
  granted_date?: string | null;
  is_system_manager?: boolean;
}

/** One row of `/modules/access/user-modules` — the signed-in user's own access. */
export interface UserModuleAccess {
  module_gid: string;
  description?: string;
  access_level: ModuleAccessLevel;
  is_system_manager?: boolean;
}
