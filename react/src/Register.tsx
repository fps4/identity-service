import { useState, type FormEvent, type CSSProperties } from 'react';
import { requestRegistration, RegisterError, type RegisteredUser } from './registration.js';
import { AuthCard, normalizeCard, type CardOptions } from './authCard.js';

export interface RegisterClassNames {
  form?: string;
  field?: string;
  label?: string;
  input?: string;
  button?: string;
  error?: string;
  hint?: string;
}

export interface InviteOptions {
  /** require a non-empty code before the form will submit (client-side guard) */
  required?: boolean;
  /** field label (default "Invite code") */
  label?: string;
  /** prefill the field — e.g. read from a `?invite=` link so the invitee types nothing */
  defaultCode?: string;
  /** helper text shown under the field */
  hint?: string;
}

export interface RegisterProps {
  /** identity-service base URL, e.g. https://auth-dev.example.com */
  baseUrl: string;
  /** called with the created user on success. Registration does NOT log the user in — that is a
   *  separate step (render <Login/> or call loginWithPassword), matching the SDK split. */
  onSuccess: (user: RegisteredUser) => void;
  onError?: (error: Error) => void;
  /** heading text; pass null to omit */
  title?: string | null;
  submitLabel?: string;
  emailLabel?: string;
  passwordLabel?: string;
  /**
   * Render an invite-code field for invite-only registration (RQ-0013). `true` shows an optional field;
   * pass options to require it, prefill it (e.g. from `?invite=`), or relabel/annotate it. Even when
   * omitted, an `invite_required` response from the server auto-reveals the field so the user can
   * recover without the developer having pre-known the registration policy.
   */
  invite?: boolean | InviteOptions;
  /** className on the root <form> */
  className?: string;
  /** per-element classNames — for Tailwind/shadcn or any design system */
  classNames?: RegisterClassNames;
  /** drop the built-in inline styles entirely (when you fully style via classNames) */
  unstyled?: boolean;
  /** override fetch (tests / SSR) */
  fetchImpl?: typeof fetch;
  /**
   * Wrap the form in opt-in, centered "card" chrome (Auth0 Universal-Login style), matching <Login/>
   * (RQ-0016). Off by default (rendered output unchanged). `true` for defaults, or an options object.
   * In card mode the title moves into the card header and the button goes full-width.
   */
  card?: boolean | CardOptions;
}

// Neutral defaults matching <Login/> so the pair renders consistently unstyled-but-usable; every
// element still takes a className, and `unstyled` drops the inline styles. (Values are duplicated
// from Login rather than shared, to keep the published <Login/> output byte-for-byte unchanged —
// ADR-0015.)
const baseStyles: Record<string, CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 14, fontWeight: 500 },
  input: { padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 14 },
  button: { padding: '9px 12px', borderRadius: 6, border: 'none', background: '#0f172a', color: '#fff', fontSize: 14, cursor: 'pointer' },
  error: { color: '#b91c1c', fontSize: 13 },
  hint: { fontSize: 12, color: '#64748b' }
};

// The server keeps invite failures generic on purpose (RQ-0013 §5) — say *that* a code failed, never
// *why*. Map the known codes to short, honest, non-probing copy; fall back to the server message.
function messageFor(err: RegisterError): string {
  switch (err.code) {
    case 'invite_required': return 'This signup needs a valid invite code.';
    case 'invalid_invite': return 'That invite code is invalid or has expired.';
    case 'registration_closed': return 'Registration is closed for this workspace.';
    case 'email_taken': return 'An account with this email already exists.';
    default: return err.message || 'Registration failed';
  }
}

/**
 * Drop-in email/password signup for identity-service's local IdP (RQ-0015) — the counterpart to
 * <Login/>. Renders a small form, performs the registration, and hands the created user back via
 * `onSuccess`. On invite-only registration (RQ-0013) it collects and submits an invite code. Token
 * storage, "then log them in", and route guarding are intentionally the host app's concern.
 */
export function Register(props: RegisterProps) {
  const {
    baseUrl, onSuccess, onError,
    title = 'Create your account', submitLabel = 'Create account',
    emailLabel = 'Email', passwordLabel = 'Password',
    invite, className, classNames = {}, unstyled = false, fetchImpl, card
  } = props;

  const inviteOpt: InviteOptions | undefined = invite === true ? {} : (invite || undefined);
  const cardOpt = normalizeCard(card);
  const inCard = !!cardOpt;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(inviteOpt?.defaultCode ?? '');
  // Flipped true when the server answers invite_required though the developer didn't mark it invite-only.
  const [autoInviteRequired, setAutoInviteRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const showInvite = !!inviteOpt || autoInviteRequired;
  const inviteRequired = !!inviteOpt?.required || autoInviteRequired;

  const style = (key: keyof typeof baseStyles): CSSProperties | undefined =>
    unstyled ? undefined : baseStyles[key];
  // In card mode the form fills the card and the button goes full-width; otherwise identical.
  const formStyle = unstyled ? undefined : (inCard ? { ...baseStyles.form, maxWidth: '100%' } : baseStyles.form);
  const buttonStyle = unstyled ? undefined : (inCard ? { ...baseStyles.button, width: '100%' } : baseStyles.button);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (inviteRequired && !inviteCode.trim()) {
      setError('An invite code is required to sign up.');
      return;
    }
    setSubmitting(true);
    try {
      const user = await requestRegistration({
        baseUrl, email, password,
        inviteCode: inviteCode.trim() || undefined,
        fetchImpl
      });
      onSuccess(user);
    } catch (err) {
      const e = err instanceof RegisterError ? err : new RegisterError('Registration failed', 0);
      setError(messageFor(e));
      if (e.code === 'invite_required') setAutoInviteRequired(true);
      onError?.(e);
    } finally {
      setSubmitting(false);
    }
  }

  const form = (
    <form className={className} style={formStyle} onSubmit={handleSubmit} noValidate>
      {!inCard && title ? <h2>{title}</h2> : null}

      <div className={classNames.field} style={style('field')}>
        <label className={classNames.label} style={style('label')} htmlFor="identity-service-register-email">{emailLabel}</label>
        <input
          id="identity-service-register-email"
          className={classNames.input}
          style={style('input')}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className={classNames.field} style={style('field')}>
        <label className={classNames.label} style={style('label')} htmlFor="identity-service-register-password">{passwordLabel}</label>
        <input
          id="identity-service-register-password"
          className={classNames.input}
          style={style('input')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {showInvite ? (
        <div className={classNames.field} style={style('field')}>
          <label className={classNames.label} style={style('label')} htmlFor="identity-service-register-invite">
            {inviteOpt?.label ?? 'Invite code'}
          </label>
          <input
            id="identity-service-register-invite"
            className={classNames.input}
            style={style('input')}
            type="text"
            autoComplete="off"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required={inviteRequired}
          />
          {inviteOpt?.hint ? <span className={classNames.hint} style={style('hint')}>{inviteOpt.hint}</span> : null}
        </div>
      ) : null}

      {error ? <div role="alert" className={classNames.error} style={style('error')}>{error}</div> : null}

      <button className={classNames.button} style={buttonStyle} type="submit" disabled={submitting}>
        {submitting ? '…' : submitLabel}
      </button>
    </form>
  );

  return inCard ? <AuthCard options={cardOpt} title={title ?? undefined}>{form}</AuthCard> : form;
}
