'use client';

import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/app/actions';

type Variant = 'default' | 'destructive' | 'outline' | 'secondary';

function SubmitButton({ label, variant, confirm }: { label: string; variant: Variant; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      variant={variant}
      disabled={pending}
      // Native confirm keeps destructive actions one click away from a guard without pulling in a dialog lib.
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      {pending ? 'Working…' : label}
    </Button>
  );
}

/**
 * Wraps a server action in a form: shows pending state, toasts the result, and — when an action
 * returns a freshly minted secret — surfaces it once via a copyable toast (it is never persisted).
 *
 * `confirm` gates submission behind a native confirm() (use for destructive actions). `inline` renders
 * a compact row (for per-row table actions) instead of the default wrapping form.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  variant = 'default',
  confirm,
  inline = false,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children?: React.ReactNode;
  variant?: Variant;
  confirm?: string;
  inline?: boolean;
}) {
  const [state, formAction] = useActionState(action, { ok: false });

  useEffect(() => {
    if (!state) return;
    if (state.secret) toast.success(state.message ?? 'Done', { description: `Secret (shown once): ${state.secret}`, duration: 30000 });
    else if (state.ok && state.message) toast.success(state.message);
    else if (!state.ok && state.message) toast.error(state.message);
  }, [state]);

  return (
    <form action={formAction} className={inline ? 'inline-flex items-center gap-2' : 'flex flex-wrap items-end gap-3'}>
      {children}
      <SubmitButton label={submitLabel} variant={variant} confirm={confirm} />
    </form>
  );
}
