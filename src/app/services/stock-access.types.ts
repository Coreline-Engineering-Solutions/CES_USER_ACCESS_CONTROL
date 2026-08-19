// Subset of STOCK_ROLES_API_HANDOVER.md's `/stock/*` types needed to manage
// location access grants from this app (per user direction: CES_USER_ACCESS_CONTROL
// is the sole admin surface for access control — this screen was originally
// mocked up as a tab inside the Stock console, but lives here instead).
// Full stock domain types live in CES_STOCK_MANAGER's stock.types.ts.

export type LocationType = 'warehouse' | 'stockpile' | 'bootstock';
export type LocationStatus = 'active' | 'frozen' | 'closed';
export type AccessScope = 'location' | 'org' | 'client';
export type AccessRole = 'auditor' | 'controller' | 'custodian' | 'receiver' | 'operator' | 'viewer';

export interface StockLocation {
  global_id: string;
  org_id: string;
  project_id: string | null;
  location_type: LocationType;
  name: string;
  custodian_user_id: string | null;
  status: LocationStatus;
}

export interface LocationAccessGrant {
  global_id: string;
  user_id: string;
  role: AccessRole;
  scope: AccessScope;
  location_id: string | null;
  org_id: string | null;
}

export interface LocationAccessGrantPayload {
  user_id: string;
  role: AccessRole;
  scope: AccessScope;
  location_id?: string | null;
  org_id?: string | null;
}

/** A real, pickable user — from GIS API `/admin/db-users`, never typed by hand. */
export interface StockUserRef {
  user_gid: string;
  email: string;
}
