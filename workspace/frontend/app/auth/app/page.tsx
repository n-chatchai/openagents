'use client';

import { useEffect, useState } from 'react';

import { getApiBaseUrl } from '@/lib/api-base';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * The phone app's sign-in landing (Pixel Team, the mobile app for this
 * workspace). The app opens this page in the system's sign-in sheet with the
 * SHA-256 of a secret it keeps (`challenge`). The door signs the person in
 * like any page; this page then asks POST /door/app-code for a two-minute code
 * bound to that challenge and hands it back to the app through its URL scheme.
 * The app trades code + secret at POST /v1/auth/app-session
 * (backend app/routers/door_auth.py). The page never sees the session.
 *
 * Only the app's own scheme is a return address: anything else would let a
 * link send a sign-in code wherever it liked.
 */
const RETURN_TO = 'pixelteam://auth';
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Phase = 'working' | 'done' | 'failed';

function AppAuth() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('working');
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    const challenge = new URLSearchParams(window.location.search).get('challenge') || '';
    if (!CHALLENGE.test(challenge)) {
      setPhase('failed');
      setError('auth.appLinkInvalid');
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/door/app-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge }),
        });
        const json = await res.json().catch(() => null);
        const code: string | undefined = json?.data?.code;
        if (!res.ok || !code) {
          setPhase('failed');
          setError(res.status === 404 ? 'auth.appNoDoor' : 'auth.signInFailedRetry');
          return;
        }
        setPhase('done');
        window.location.replace(`${RETURN_TO}?code=${encodeURIComponent(code)}`);
      } catch {
        setPhase('failed');
        setError('auth.signInFailedRetry');
      }
    })();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="text-center max-w-md px-8">
        <h1 className={`text-xl font-semibold tracking-tight ${phase === 'failed' ? 'text-destructive' : ''}`}>
          {phase === 'failed' ? t('auth.signInFailed') : phase === 'done' ? t('auth.appReturn') : t('auth.signingIn')}
        </h1>
        {error ? <p className="text-sm text-muted-foreground mt-1">{t(error)}</p> : null}
      </div>
    </div>
  );
}

export default function AppAuthPage() {
  return <AppAuth />;
}
