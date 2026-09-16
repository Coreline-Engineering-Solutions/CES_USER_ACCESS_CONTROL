import { cesGisApiUrl } from '../app/ces-hosts';

export const environment = {
  production: true,
  // Per STOCK_ROLES_API_HANDOVER.md (2026-07-26) — same GIS API as CES_MODULES/CES_NG_GIS.
  apiBaseUrl: cesGisApiUrl('https://gis-api.onrender.com')
};
