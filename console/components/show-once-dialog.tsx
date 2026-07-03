'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Modal for material that is shown exactly once (client secrets, invite codes — never persisted
 * server-side). Replaces the old 30-second toast: the value stays on screen until the operator
 * explicitly dismisses it, with a one-click copy (RQ-0013).
 */
export function ShowOnceDialog({ title, value, hint, onClose }: {
  title: string;
  value: string;
  hint?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the value is selectable below.
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">
          {hint ?? 'Shown once — it is never stored. Copy it now; if it is lost it must be rotated.'}
        </p>
        <div className="flex items-center gap-2">
          <code data-testid="show-once-value" className="flex-1 select-all break-all rounded bg-muted px-3 py-2 font-mono text-sm">{value}</code>
          <Button size="sm" variant="outline" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>I&apos;ve stored it</Button>
        </div>
      </div>
    </div>
  );
}
