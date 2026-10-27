import { getApiBaseUrl } from '@/lib/api-base';
import { clearWorkspaceSession, saveWorkspaceSession, type WorkspaceSession } from '@/lib/workspace-session';

// Sign-in through a door — a self-hosted workspace behind an authenticating
// proxy (Erawan runs oauth2-proxy with Google in front of it).
//
// The door already knows who the person is and passes their email to the
// backend, which mints an ordinary workspace session for it
// (POST /door/session, backend app/routers/door_auth.py). The rest of
// the app treats that session exactly like a Firebase login.
//
// NEXT_PUBLIC_DOOR_LOGIN=1 (build-time) makes this host first-party and swaps
// every sign-in and sign-out for the door's own /oauth2/start and
// /oauth2/sign_out, in place of openagents.org's.
export const DOOR_LOGIN = process.env.NEXT_PUBLIC_DOOR_LOGIN === '1';

const REDIRECT_KEY = 'oa_door_redirect_at';

/** Ask the door who this is. Null when the door vouches for nobody. */
export async function fetchDoorSession(): Promise<WorkspaceSession | null> {
  const res = await fetch(`${getApiBaseUrl()}/door/session`, { method: 'POST' });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.session_token) return null;
  const session: WorkspaceSession = {
    token: json.data.session_token,
    email: json.data.email,
    displayName: json.data.display_name ?? null,
    expiresAt: Math.floor(new Date(json.data.expires_at).getTime() / 1000),
  };
  saveWorkspaceSession(session);
  return session;
}

/**
 * Through the door's sign-in, back to where the person was. Once per half
 * minute: if the door lets them in but still no session comes back (the
 * backend has no session secret, say), sending them round again would loop.
 */
export function goToDoorLogin(): void {
  if (typeof window === 'undefined') return;
  try {
    const last = Number(sessionStorage.getItem(REDIRECT_KEY) || 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(REDIRECT_KEY, String(Date.now()));
  } catch {
    /* storage unavailable — redirect anyway */
  }
  const rd = window.location.pathname + window.location.search + window.location.hash;
  window.location.href = `/oauth2/start?rd=${encodeURIComponent(rd)}`;
}

/** End the door's session; its sign-in page is where the person lands. */
export function goToDoorLogout(): void {
  if (typeof window === 'undefined') return;
  clearWorkspaceSession();
  window.location.href = `/oauth2/sign_out?rd=${encodeURIComponent('/')}`;
}
