// The one network call behind <Register/> (RQ-0015): self-service local-credential registration
// against identity-service (POST /v1/register, RQ-0002/RQ-0013). Kept as a standalone, framework-free
// function — unit-testable with a mocked fetch and reusable by custom UIs, mirroring
// requestPasswordToken. Self-contained on purpose: this package depends only on React (peer), nothing
// else — in particular NOT the SDK, so server-side consumers never pull in React.

export interface RegisteredUser {
  id: string;
  email: string;
}

export interface RegistrationRequest {
  /** identity-service base URL, e.g. https://auth-dev.example.com */
  baseUrl: string;
  email: string;
  password: string;
  /** operator-issued invite code — required when the registration policy is `invite` (RQ-0013) */
  inviteCode?: string;
  /** override fetch (tests / SSR); defaults to global fetch */
  fetchImpl?: typeof fetch;
}

/**
 * Thrown on a rejected registration. Carries the HTTP `status` and the server's error `code`
 * (e.g. `invite_required`, `invalid_invite`, `registration_closed`, `email_taken`) so a UI can react —
 * but note the invite codes are deliberately generic (RQ-0013 §5): they say *that* a code failed, not
 * *why*, and callers must not try to infer more.
 */
export class RegisterError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'RegisterError';
  }
}

export async function requestRegistration(req: RegistrationRequest): Promise<RegisteredUser> {
  const fetcher = req.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetcher) {
    throw new RegisterError('No fetch implementation available', 0);
  }

  const base = req.baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/register`;

  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: req.email,
      password: req.password,
      // only send the field when present, so open registration isn't handed an empty code
      ...(req.inviteCode ? { inviteCode: req.inviteCode } : {})
    })
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    // The register endpoint returns { error, message } (UserServiceError envelope), not OAuth's
    // error_description. Prefer the human message; keep the code for the UI to branch on.
    throw new RegisterError(data?.message ?? data?.error ?? 'Registration failed', response.status, data?.error);
  }

  return { id: data.id, email: data.email };
}
