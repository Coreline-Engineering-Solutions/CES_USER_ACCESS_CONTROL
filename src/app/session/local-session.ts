const LOCAL_SESSION_PATH = '/assets/local-session.dev.json';
const LOCAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isLocalHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname.endsWith('.local')) return true;
  if (hostname.startsWith('192.168.') || hostname.startsWith('10.')) return true;
  return false;
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(prefix));
  return match ? decodeURIComponent(match.substring(prefix.length)) : null;
}

function setCookie(name: string, value: string): void {
  const encoded = encodeURIComponent(value);
  document.cookie = `${name}=${encoded}; Path=/; Max-Age=${LOCAL_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Dev-only convenience: on localhost, seed session_gid/user_email cookies
 * from a gitignored src/assets/local-session.dev.json so you can test the
 * app without going through the real corelineengineering.com SSO flow.
 * No-ops in production and whenever that file doesn't exist.
 */
export async function hydrateLocalSession(): Promise<void> {
  if (!isBrowser()) return;
  if (!isLocalHost(window.location.hostname)) return;

  let session: { email: string; session_gid: string } | null = null;
  try {
    const res = await fetch(LOCAL_SESSION_PATH, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.email && data?.session_gid) {
        session = { email: String(data.email), session_gid: String(data.session_gid) };
      }
    }
  } catch {
    return;
  }
  if (!session) return;

  const currentGid = readCookie('session_gid');
  const currentEmail = (readCookie('user_email') || '').toLowerCase();
  const nextEmail = session.email.toLowerCase();

  if (currentGid === session.session_gid && currentEmail === nextEmail) {
    return;
  }

  setCookie('session_gid', session.session_gid);
  setCookie('user_email', nextEmail);
}
