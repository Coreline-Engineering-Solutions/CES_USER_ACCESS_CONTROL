/**
 * Sibling-app URLs that follow the environment the page is running in.
 *
 * Production lives on `<app>.corelineengineering.com` (the hub on `www.`);
 * QA lives on `<app>.qa.corelineengineering.com` (the hub on `qa.`). The
 * session cookie is scoped per environment by CES_WEB, so a QA page must
 * link to QA siblings or the user silently crosses into production with
 * the wrong cookie. Local development links to production, as before.
 *
 * Identical copy in every CES frontend — keep them the same.
 */

export type CesApp = 'hub' | 'gis' | 'modules' | 'stock' | 'useraccess' | 'access';

const PROD: Record<CesApp, string> = {
  hub: 'https://www.corelineengineering.com',
  gis: 'https://gis.corelineengineering.com',
  modules: 'https://modules.corelineengineering.com',
  stock: 'https://stock.corelineengineering.com',
  useraccess: 'https://useraccess.corelineengineering.com',
  access: 'https://access.corelineengineering.com',
};

const QA: Record<CesApp, string> = {
  hub: 'https://qa.corelineengineering.com',
  gis: 'https://gis.qa.corelineengineering.com',
  modules: 'https://modules.qa.corelineengineering.com',
  stock: 'https://stock.qa.corelineengineering.com',
  useraccess: 'https://useraccess.qa.corelineengineering.com',
  access: 'https://access.qa.corelineengineering.com',
};

/** True on any `*.qa.corelineengineering.com` host (or `qa.` itself). */
export function isQaHost(hostname: string = typeof window !== 'undefined' ? window.location.hostname : ''): boolean {
  const h = String(hostname ?? '').toLowerCase();
  return h === 'qa.corelineengineering.com' || h.endsWith('.qa.corelineengineering.com');
}

/** Base URL (no trailing slash) of a sibling app in the current environment. */
export function cesAppUrl(app: CesApp, path: string = ''): string {
  const base = (isQaHost() ? QA : PROD)[app];
  if (!path) return base;
  return base + (path.startsWith('/') || path.startsWith('#') ? '' : '/') + path;
}

/**
 * Rewrite any production CES URL to its QA counterpart when on a QA host.
 * Unknown hosts are returned unchanged - a tool with no QA deployment keeps
 * pointing at production, which is correct.
 */
export function toEnvUrl(url: string): string {
  if (!isQaHost()) return url;
  try {
    const u = new URL(url);
    const entry = (Object.keys(PROD) as CesApp[]).find((k) => new URL(PROD[k]).host === u.host);
    if (!entry) return url;
    const q = new URL(QA[entry]);
    u.protocol = q.protocol;
    u.host = q.host;
    return u.toString();
  } catch {
    return url;
  }
}

// ─── GIS API per environment ─────────────────────────────────────────────────
// tiaan stood up a QA copy of gis-api (15 Sep): `gis-api-qa.corelinegis.com`,
// auto-deployed from every commit to its main; production is promoted by hand.
// A page on a QA host talks to the QA API, so fixes land there first and are
// tested on the QA sites before promotion - the same rule as the frontends.
// Same databases, same Auth API; only the API build differs.
const GIS_API_QA = 'https://gis-api-qa.corelinegis.com';

/**
 * The gis-api base URL for the environment the page is on. `prod` is the
 * app's own production value (some apps use the CDN host, some the direct
 * onrender host) so production behaviour is unchanged by this helper.
 */
export function cesGisApiUrl(prod: string = 'https://gis-api.corelinegis.com'): string {
  return isQaHost() ? GIS_API_QA : prod;
}
