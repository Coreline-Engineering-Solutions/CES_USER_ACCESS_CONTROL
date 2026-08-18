// Types matching CES_NG_GIS's `/admin/projects/*` and `/admin/user-projects`
// surface (see CES_NG_GIS/src/classes/ClassesGIS.ts). Same backend as
// Stock/Modules — confirmed live 2026-08-18.
//
// The two read endpoints use DIFFERENT field names for the same data —
// confirmed live, not a guess:
//   /admin/projects/all   -> { project_id, name,         description }
//   /admin/user-projects  -> { project_id, project_name, project_description }
// GisAccessApiService normalises both into GisProject so the panel only
// ever deals with one shape.

export interface GisProject {
  project_id: number;
  name: string;
  description: string;
}

/** Result of an assign call — which of the requested names actually matched a project. */
export interface GisProjectAssignResult {
  assigned: string[];
  missing: string[];
}
