'use client';
import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { getApiBaseUrl } from '@/lib/api-base';
import { useT } from '@/lib/i18n';
import type { PairingCode } from '@/lib/types';
import { cn } from '@/lib/utils';

// Behind a door (lib/door.ts) a device pairs with this server only: the
// launcher pinned from npm, no remote script, no install hooks.
// openagents.org's install.sh follows their develop branch and pairs with
// their server unless told otherwise, and the onboarding panel points there.
const DOOR_INSTALL_COMMAND = 'npm install -g --ignore-scripts @openagents-org/agent-launcher@0.2.206';
// --endpoint keeps the pairing on this server; --no-update-check goes last
// (the CLI's parser takes the next word as its value otherwise).
const doorPairCommand = (code: string) =>
  `agn device connect ${code} --endpoint ${getApiBaseUrl()} --no-update-check`;

/** A monospace command line with a copy button. */
function CommandRow({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-2 rounded-md border bg-zinc-950 dark:bg-black px-3 py-2">
      <code className="flex-1 min-w-0 text-xs font-mono text-zinc-100 overflow-x-auto whitespace-nowrap">
        {command}
      </code>
      <button
        onClick={copy}
        className="shrink-0 size-6 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors"
        title={t('connect.nodeCopyCommand')}
      >
        {copied ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** One numbered step in the pairing walkthrough, with a connector rail. */
function PairingStep({
  n,
  title,
  last = false,
  children,
}: {
  n: number;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex flex-col items-center">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
          {n}
        </span>
        {!last && <span className="mt-1.5 w-px flex-1 bg-border" />}
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-6')}>
        <div className="text-sm font-semibold leading-6">{title}</div>
        <div className="mt-2.5 space-y-2.5">{children}</div>
      </div>
    </div>
  );
}

/** Pairing a computer behind the door: install the pinned launcher, then pair here. */
export function DoorPairingPanel({
  pairing,
  onDismiss,
}: {
  pairing: PairingCode;
  onDismiss: () => void;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const [codeCopied, setCodeCopied] = useState(false);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [pairing.expiresAt]);

  const expired = remaining <= 0;
  const minutes = Math.max(1, Math.ceil(remaining / 60));

  const copyCode = () => {
    navigator.clipboard.writeText(pairing.code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border bg-background overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="px-5 py-3.5 border-b flex items-center justify-between">
        <span className="text-sm font-semibold">{t('connect.nodePairingTitle')}</span>
        <span className={cn(
          'text-xs font-medium rounded-full px-2.5 py-1',
          expired ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-600 dark:text-amber-500',
        )}>
          {expired ? t('connect.nodePairingExpired') : t('connect.nodePairingExpires', { minutes })}
        </span>
      </div>

      <div className="p-5">
        <PairingStep n={1} title={t('connect.doorStep1Title')}>
          <p className="text-xs text-muted-foreground">{t('connect.doorInstallHint')}</p>
          <CommandRow command={DOOR_INSTALL_COMMAND} />
        </PairingStep>

        <PairingStep n={2} title={t('connect.nodeStep2Title')}>
          <button
            onClick={copyCode}
            disabled={expired}
            className={cn(
              'group w-full flex items-center justify-center gap-3 rounded-2xl border-2 border-dashed py-6 transition-colors',
              expired
                ? 'opacity-50 cursor-not-allowed border-zinc-200 dark:border-zinc-800'
                : 'border-border bg-muted/30 hover:bg-muted/60',
            )}
            title={t('connect.nodeCopyCode')}
          >
            <span className="text-4xl leading-none font-mono font-bold tracking-[0.25em] tabular-nums">{pairing.code}</span>
            {codeCopied
              ? <Check className="size-6 text-green-500" />
              : <Copy className="size-6 text-muted-foreground group-hover:text-foreground transition-colors" />}
          </button>
          <p className="text-xs text-muted-foreground">{t('connect.doorPairHint')}</p>
          <CommandRow command={doorPairCommand(pairing.code)} />
          <ul className="list-disc pl-4 space-y-1 text-xs text-muted-foreground">
            <li>{t('connect.doorNoteMenu')}</li>
            <li>{t('connect.doorNoteFolder')}</li>
          </ul>
          {isMobile && (
            <p className="text-xs text-muted-foreground">{t('connect.nodeMobileCodeHint')}</p>
          )}
        </PairingStep>

        {/* Live "waiting for the device" indicator; the parent watches the
            node list and dismisses this when a device connects. */}
        <PairingStep n={3} title={t('connect.nodeStep3Title')} last>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="relative flex size-5 shrink-0 items-center justify-center">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
                <Loader2 className="size-5 animate-spin text-primary" />
              </span>
              <span className="text-xs font-medium truncate">{t('connect.nodeWaiting')}</span>
            </div>
            <Button size="sm" variant="ghost" onClick={onDismiss}>{t('connect.nodeCancel')}</Button>
          </div>
        </PairingStep>
      </div>
    </div>
  );
}
