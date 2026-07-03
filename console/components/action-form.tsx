'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ShowOnceDialog } from '@/components/show-once-dialog';
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
 * returns freshly minted show-once material (a client secret, an invite code) — surfaces it in a
 * blocking dialog with a copy button until the operator dismisses it (it is never persisted).
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
  const [reveal, setReveal] = useState<{ title: string; value: string; hint?: string } | null>(null);

  useEffect(() => {
    if (!state) return;
    if (state.secret) setReveal({ title: state.message ?? 'Done', value: state.secret, hint: state.secretHint });
    else if (state.ok && state.message) toast.success(state.message);
    else if (!state.ok && state.message) toast.error(state.message);
  }, [state]);

  return (
    <form action={formAction} className={inline ? 'inline-flex items-center gap-2' : 'flex flex-wrap items-end gap-3'}>
      {children}
      <SubmitButton label={submitLabel} variant={variant} confirm={confirm} />
      {reveal && <ShowOnceDialog title={reveal.title} value={reveal.value} hint={reveal.hint} onClose={() => setReveal(null)} />}
    </form>
  );
}
