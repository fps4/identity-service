import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// A small status pill (shadcn-style). Tones map to the states the console shows at a glance —
// user status, sign-in method, registration policy (RQ-0014, ADR-0014). Uses Tailwind's built-in
// palette (matching the existing text-green-600 usage) so it needs no new theme tokens.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        success: 'bg-green-500/10 text-green-600 dark:text-green-400',
        warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        info: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
        danger: 'bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** render a leading status dot in the current text colour */
  dot?: boolean;
}

export function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
