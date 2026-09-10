// Subset of STOCK_ROLES_API_HANDOVER.md's `/stock/*` types needed to manage
// location and org access from this app (per user direction: CES_USER_ACCESS_CONTROL
// is the sole admin surface for access control — this screen was originally
// mocked up as a tab inside the Stock console, but lives here instead).
//
// CES_STOCK_MANAGER's stock.types.ts is the source of truth. The stock/org
// access types below (LocationType, LocationStatus, AccessScope, AccessRole,
// GeoPoint, StockLocation, Location{Create,Update}Payload, LocationAccessGrant,
// LocationAccessGrantPayload, OrgRow) are kept byte-identical to it — only the
// UAC-only additions (OrgCreatePayload, StockUserRef) and the leading comments
// differ. Full stock domain types (items, transfers, GRNs, …) stay there.

export type LocationType = 'warehouse' | 'stockpile' | 'bootstock';
export type LocationStatus = 'active' | 'frozen' | 'closed';
export type AccessScope = 'location' | 'org' | 'client';
export type AccessRole = 'auditor' | 'controller' | 'custodian' | 'receiver' | 'operator' | 'viewer';

export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

export interface StockLocation {
  global_id: string;
  org_id: string;
  project_id: string | null;
  location_type: LocationType;
  name: string;
  custodian_user_id: string | null;
  status: LocationStatus;
  geom_source: 'gps' | 'last_stock_location' | 'manual' | null;
  geom: GeoPoint | null;
}

/** Mirrors CES_STOCK_MANAGER's LocationCreatePayload (stock.types.ts) — same
 *  /stock/locations/create endpoint, same backend, this app just hadn't
 *  wired it up yet (org creation was pulled out to here; location creation
 *  wasn't, so an admin registering a brand-new org had no way to give it
 *  anywhere to hold stock without switching to Stock Manager). */
export interface LocationCreatePayload {
  org_id: string;
  name: string;
  location_type: LocationType;
  project_id?: string | null;
  custodian_user_id?: string | null;
  geom?: GeoPoint | null;
  geom_source?: 'gps' | 'last_stock_location' | 'manual' | null;
}

/** Byte-identical to CES_STOCK_MANAGER's LocationUpdatePayload. This app does
 *  not currently wrap `/stock/locations/update` (edits stay in Stock Manager),
 *  but the type is carried so the two never drift. */
export interface LocationUpdatePayload {
  location_id: string;
  name?: string | null;
  status?: LocationStatus | null;
  /** Bootstock only — repoint a bootstock at a new custodian. */
  custodian_user_id?: string | null;
  /** Stockpile only — repoint a stockpile at a different project. */
  project_id?: string | null;
  geom?: GeoPoint | null;
  geom_source?: 'gps' | 'last_stock_location' | 'manual' | null;
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

// ─── Organisations ────────────────────────────────────────────────────────
// A real org directory (name -> client_db_gid), confirmed live via
// /stock/orgs/create + /stock/orgs/list. Lives here rather than
// CES_STOCK_MANAGER because orgs are an access-control primitive — org_id
// on every location/grant IS a client_db_gid, so this directory is what
// finally gives those ids a real name instead of the old "Demo Org …"
// placeholder labels.
export interface OrgCreatePayload {
  name: string;
  client_db_gid: string;
}

export interface OrgRow {
  global_id?: string;
  name: string;
  client_db_gid: string;
  /** Declared on CES_STOCK_MANAGER's OrgRow; neither app reads it yet, but
   *  the two declarations should not disagree. */
  status?: string;
  [key: string]: unknown;
}
