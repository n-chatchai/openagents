'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { GrokBotSetup as Setup } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// How long a test waits for Grok Bot's routine run to call back.
const TEST_WAIT_MS = 120_000;
const POLL_MS = 3_000;

// The Grok Bot whose setup is under way in this tab. Adding it ends a first
// run (the workspace now has an agent), so the steps resume in the Connect
// view from here, and after a reload.
const PENDING_KEY = 'oa_grokbot_setup';

export function pendingGrokSetup(): string | null {
  try {
    return sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

function setPending(name: string | null) {
  try {
    if (name) sessionStorage.setItem(PENDING_KEY, name);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the steps then only last while this view is open.
  }
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'waiting'; sentAt: string }
  | { kind: 'connected' }
  | { kind: 'silent' }
  | { kind: 'failed'; problem: string };

function CopyValue({ label, value, shown }: { label: string; value: string; shown?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
        <code className="flex-1 min-w-0 truncate text-xs font-mono">{shown ?? value}</code>
        <button
          onClick={copy}
          className="shrink-0 size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title={t('connect.grokCopy')}
        >
          {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 size-5 shrink-0 rounded-full bg-muted text-[11px] font-medium flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 min-w-0 space-y-2">
        <div>
          <div className="text-sm font-medium">{title}</div>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

/**
 * Somebody's own Grok Bot, set up in the order Grok Bot needs it: the agent
 * joins, its owner adds this workspace as a plugin, has Grok make a webhook
 * routine, pastes the routine's webhook back, and a test wake proves both
 * directions (backend app/services/grokbot_agent.py).
 */
export function GrokBotSetup({ onAdded, onDone }: { onAdded: () => void; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(() => pendingGrokSetup() || 'grok');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookKey, setWebhookKey] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [showPlugin, setShowPlugin] = useState(false);

  const start = async (agentName = name.trim()) => {
    if (!agentName) return;
    setBusy(true);
    try {
      let found: Setup;
      try {
        // Somebody coming back to finish: their Grok Bot is already here.
        found = await workspaceApi.getGrokBotSetup(agentName);
      } catch {
        await workspaceApi.addCloudAgent({ agentName, provider: 'grokbot', model: 'grokbot', apiKey: '' });
        found = await workspaceApi.getGrokBotSetup(agentName);
        setPending(agentName);
        onAdded();
      }
      setSetup(found);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('connect.cloudAgentAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  const tested = (result: Setup) => {
    setSetup(result);
    if (result.testProblem) setTest({ kind: 'failed', problem: result.testProblem });
    else if (result.testSentAt) setTest({ kind: 'waiting', sentAt: result.testSentAt });
  };

  const saveAndTest = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      tested(await workspaceApi.saveGrokBotRoutine(setup.agentName, webhookUrl.trim(), webhookKey.trim()));
      setWebhookKey('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('connect.cloudAgentAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  const testAgain = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      tested(await workspaceApi.testGrokBot(setup.agentName));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('connect.cloudAgentAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Back to a setup under way (see PENDING_KEY).
  useEffect(() => {
    const pending = pendingGrokSetup();
    if (pending) start(pending);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const done = () => {
    setPending(null);
    onDone();
  };

  // The routine run calls back over MCP; its call is the agent's last contact.
  useEffect(() => {
    if (test.kind !== 'waiting' || !setup) return;
    const started = Date.now();
    const sentAt = Date.parse(test.sentAt);
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try {
        const now = await workspaceApi.getGrokBotSetup(setup.agentName);
        if (stopped) return;
        if (now.lastContactAt && Date.parse(now.lastContactAt) >= sentAt) {
          setTest({ kind: 'connected' });
          return;
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
      if (stopped) return;
      if (Date.now() - started > TEST_WAIT_MS) {
        setTest({ kind: 'silent' });
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [test, setup?.agentName]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = setup?.connectionKey ?? '';
  const maskedKey = key.length > 16 ? `${key.slice(0, 12)}${'•'.repeat(10)}` : key;

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="grok-name" className="text-xs">{t('connect.grokNameLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id="grok-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!setup}
            className="text-sm h-9"
          />
          {!setup && (
            <Button onClick={() => start()} disabled={busy || !name.trim()} size="sm" className="h-9 shrink-0">
              {busy && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              {t('connect.grokContinue')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('connect.grokNameHint')}</p>
      </div>

      {setup && (
        <ol className="space-y-5">
          <Step
            n={1}
            title={t('connect.grokStepPlugin')}
            hint={setup.pluginUsedBy
              ? t('connect.grokPluginAdded', { name: setup.pluginUsedBy })
              : t('connect.grokStepPluginHint')}
          >
            {/* One plugin serves all of a person's Grok Bots. */}
            {setup.pluginUsedBy && !showPlugin ? (
              <Button size="sm" variant="outline" onClick={() => setShowPlugin(true)}>
                {t('connect.grokShowPlugin')}
              </Button>
            ) : (
              <>
                <CopyValue label={t('connect.grokPluginName')} value={setup.pluginName} />
                <CopyValue label={t('connect.grokPluginUrl')} value={setup.mcpUrl} />
                <CopyValue label={t('connect.grokHeaderName')} value={setup.headerName} />
                <CopyValue label={t('connect.grokHeaderValue')} value={key} shown={maskedKey} />
              </>
            )}
          </Step>

          <Step n={2} title={t('connect.grokStepRoutine')} hint={t('connect.grokStepRoutineHint', { name: setup.agentName })}>
            <Textarea readOnly value={setup.routinePrompt} className="text-xs font-mono min-h-[120px]" />
            <CopyRoutine prompt={setup.routinePrompt} />
          </Step>

          <Step n={3} title={t('connect.grokStepWebhook')} hint={t('connect.grokStepWebhookHint')}>
            <div className="space-y-1.5">
              <Label htmlFor="grok-webhook-url" className="text-xs">{t('connect.grokWebhookUrl')}</Label>
              <Input
                id="grok-webhook-url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://api2.cursor.sh/automations/webhook/…"
                className="text-sm font-mono h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grok-webhook-key" className="text-xs">{t('connect.grokWebhookKey')}</Label>
              <Input
                id="grok-webhook-key"
                type="password"
                autoComplete="off"
                value={webhookKey}
                onChange={(e) => setWebhookKey(e.target.value)}
                className="text-sm font-mono h-9"
              />
            </div>
            {setup.webhookSet && <p className="text-xs text-muted-foreground">{t('connect.grokWebhookSaved')}</p>}
            <div className="flex gap-2">
              <Button
                onClick={saveAndTest}
                disabled={busy || test.kind === 'waiting' || !webhookUrl.trim() || !webhookKey.trim()}
                size="sm"
              >
                {busy && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                {t('connect.grokSaveTest')}
              </Button>
              {setup.webhookSet && (
                <Button onClick={testAgain} disabled={busy || test.kind === 'waiting'} size="sm" variant="outline">
                  {t('connect.grokTestAgain')}
                </Button>
              )}
            </div>
            {test.kind === 'waiting' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('connect.grokWaiting')}
              </p>
            )}
            {test.kind === 'connected' && (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <CheckCircle2 className="size-3.5" />
                {t('connect.grokConnected', { name: setup.agentName })}
              </p>
            )}
            {(test.kind === 'silent' || test.kind === 'failed') && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 mt-px shrink-0" />
                {test.kind === 'failed' ? test.problem : t('connect.grokSilent')}
              </p>
            )}
          </Step>
        </ol>
      )}

      {setup && (
        <Button onClick={done} size="sm" variant="outline" className="w-full">
          {t('connect.grokDone')}
        </Button>
      )}
    </div>
  );
}

function CopyRoutine({ prompt }: { prompt: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
      {copied ? t('connect.grokCopied') : t('connect.grokCopyPrompt')}
    </Button>
  );
}
