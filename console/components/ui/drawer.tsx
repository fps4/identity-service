'use client';

import type { ReactNode } from 'react';

// A right-side detail drawer (RQ-0017, ADR-0014): a scrim + sliding panel with a header, scrollable
// body, and an optional action footer. Shared by the clients and invites directories so every
// entity's detail view reads the same. Escape/backdrop click close via onClose.
export function Drawer({ title, subtitle, badges, onClose, children, footer, ariaLabel }: {
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l bg-background shadow-lg">
        <div className="flex items-start gap-3 border-b p-5">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{title}</div>
            {subtitle ? <div className="truncate font-mono text-xs text-muted-foreground">{subtitle}</div> : null}
            {badges ? <div className="mt-2 flex flex-wrap gap-2">{badges}</div> : null}
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">✕</button>
        </div>
        <div className="flex-1 space-y-6 overflow-auto p-5 text-sm">{children}</div>
        {footer ? <div className="flex flex-wrap items-center gap-2 border-t p-4">{footer}</div> : null}
      </aside>
    </div>
  );
}
