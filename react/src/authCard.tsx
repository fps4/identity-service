import type { CSSProperties, ReactNode } from 'react';

// Opt-in "card" chrome shared by <Login/> and <Register/> (RQ-0016) — the Auth0 Universal-Login look:
// a centered, elevated card with a brand header and an optional footer link, on a full-viewport page.
// It is OFF by default; passing `card` turns it on. It wraps the form untouched, so it composes with
// every existing prop (google, hidePasswordForm, invite, classNames…). Page chrome only — the form's
// field styling still follows `classNames` / `unstyled`.

export interface CardOptions {
  /** brand mark shown centered above the title — any node (an <img>, an svg, or text) */
  logo?: ReactNode;
  /** small muted line under the title */
  subtitle?: string;
  /** content under the form — e.g. a "Sign up" / "Log in" link */
  footer?: ReactNode;
  /** card max width in px (default 400) */
  width?: number;
  /** center the card in a full-viewport page with a subtle background (default true) */
  fullViewport?: boolean;
}

/** Normalize the `card` prop: falsy → null (no chrome), `true` → defaults, object → itself. */
export function normalizeCard(card: boolean | CardOptions | undefined): CardOptions | null {
  if (!card) return null;
  return card === true ? {} : card;
}

const s = {
  page: {
    minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    padding: '72px 24px', background: '#f1f5f9', boxSizing: 'border-box'
  },
  card: {
    width: '100%', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14,
    boxShadow: '0 24px 60px rgba(15, 23, 42, 0.12)', padding: '32px 32px 26px', boxSizing: 'border-box'
  },
  brand: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 20 },
  title: { fontSize: 20, fontWeight: 650, textAlign: 'center', margin: 0 },
  subtitle: { fontSize: 13, color: '#64748b', textAlign: 'center', margin: '6px 0 0' },
  footer: { textAlign: 'center', fontSize: 13, color: '#64748b', marginTop: 18 }
} satisfies Record<string, CSSProperties>;

/**
 * Wrap a form in the card chrome. `title` is rendered in the card header (the caller suppresses its
 * own inline heading in card mode). Consumers who want a bare form simply don't pass `card`.
 */
export function AuthCard({ options, title, children }: {
  options: CardOptions;
  title?: ReactNode;
  children: ReactNode;
}) {
  const hasHeader = options.logo != null || title != null || options.subtitle != null;
  const card = (
    <div style={{ ...s.card, maxWidth: options.width ?? 400 }}>
      {hasHeader ? (
        <div style={s.brand}>
          {options.logo}
          {title != null ? <h1 style={s.title}>{title}</h1> : null}
          {options.subtitle ? <p style={s.subtitle}>{options.subtitle}</p> : null}
        </div>
      ) : null}
      {children}
      {options.footer ? <div style={s.footer}>{options.footer}</div> : null}
    </div>
  );
  return options.fullViewport === false ? card : <div style={s.page}>{card}</div>;
}
