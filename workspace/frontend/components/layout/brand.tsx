'use client';

import { useRef, useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n';

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
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-full min-w-0 border-b border-primary bg-transparent text-sm font-medium outline-none"
            autoFocus
          />
        ) : (
          <span
            className="truncate text-sm font-medium cursor-pointer transition-colors hover:text-primary"
            onClick={startEditing}
            title={t('header.clickToRename')}
          >
            {workspace?.name || t('nav.workspaceFallback')}
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">{t('metadata.title')}</span>
      </div>
    </div>
  );
}
