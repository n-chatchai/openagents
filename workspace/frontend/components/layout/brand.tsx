'use client';

import { useRef, useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WithTooltip } from '@/components/ui/with-tooltip';

/**
 * The workspace's first letter in a small tile — the brand mark when there is
 * no room for its name (the collapsed icon rail).
 */
export function WorkspaceInitial({ name }: { name: string }) {
  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
      title={name}
      aria-hidden
    >
      {Array.from(name.trim())[0]?.toUpperCase() || '·'}
    </span>
  );
}

/**
 * Sidebar brand block: workspace name (click to rename) over the product name.
 * Collapses to the workspace's first letter on the icon rail.
 */
export function Brand() {
  const { workspace, renameWorkspace } = useWorkspace();
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setDraft(workspace?.name || '');
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== workspace?.name) {
      renameWorkspace(trimmed);
    }
  };

  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <span className="hidden group-data-[collapsible=icon]:flex">
        <WorkspaceInitial name={workspace?.name || t('nav.workspaceFallback')} />
      </span>

      <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
        {editing ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={t('workspaceLanding.renameTitle')}
            className="h-8 font-medium"
            autoFocus
          />
        ) : (
          <WithTooltip label={t('header.clickToRename')}>
            <Button variant="ghost" size="sm" onClick={startEditing} className="-mx-1 w-fit max-w-full min-w-0 shrink justify-start px-1 text-base font-semibold">
              <span className="truncate">{workspace?.name || t('nav.workspaceFallback')}</span>
            </Button>
          </WithTooltip>
        )}
        <span className="truncate text-xs text-muted-foreground">{t('metadata.title')}</span>
      </div>
    </div>
  );
}
