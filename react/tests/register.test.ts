import { describe, it, expect } from 'vitest';
import { requestRegistration, RegisterError } from '../src/registration.js';

// A fake fetch that records the request and returns a canned response (same shape as login.test.ts).
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body))
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('requestRegistration (RQ-0015)', () => {
  it('POSTs a JSON registration to the tenant register endpoint and maps the created user', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'usr_1', email: 'new@acme.test', tenantId: 'tenant-local' });

    const user = await requestRegistration({
      baseUrl: 'https://auth.example.com/', tenantId: 'tenant-local',
      email: 'new@acme.test', password: 'correct-horse-battery', inviteCode: 'V7QK-3MHP-XA2D', fetchImpl: impl
    });

    expect(user).toEqual({ id: 'usr_1', email: 'new@acme.test', tenantId: 'tenant-local' });

    // Register endpoint, tenant in path, trailing slash normalized, JSON body carrying the invite code.
    expect(calls[0].url).toBe('https://auth.example.com/v1/tenants/tenant-local/register');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toEqual({ email: 'new@acme.test', password: 'correct-horse-battery', inviteCode: 'V7QK-3MHP-XA2D' });
  });

  it('omits inviteCode from the body when none is supplied (open-registration tenant)', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'usr_2', email: 'x@acme.test', tenantId: 't1' });
    await requestRegistration({ baseUrl: 'https://auth.example.com', tenantId: 't1', email: 'x@acme.test', password: 'pw', fetchImpl: impl });
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).not.toHaveProperty('inviteCode');
    expect(Object.keys(sent).sort()).toEqual(['email', 'password']);
  });

  it('encodes the tenant id into the path', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'u', email: 'e', tenantId: 'a/b' });
    await requestRegistration({ baseUrl: 'https://auth.example.com', tenantId: 'a/b', email: 'e', password: 'pw', fetchImpl: impl });
    expect(calls[0].url).toBe('https://auth.example.com/v1/tenants/a%2Fb/register');
  });

  it('throws a RegisterError carrying status and code on a gated registration', async () => {
    const { impl } = fakeFetch(403, { error: 'invite_required', message: 'An invite code is required' });
    await expect(requestRegistration({
      baseUrl: 'https://auth.example.com', tenantId: 'tenant-local',
      email: 'new@acme.test', password: 'pw', fetchImpl: impl
    })).rejects.toMatchObject({ name: 'RegisterError', status: 403, code: 'invite_required' });
  });

  it('surfaces invalid_invite as a RegisterError code (UI maps to generic copy)', async () => {
    const { impl } = fakeFetch(403, { error: 'invalid_invite', message: 'Invalid or expired invite code' });
    const err = await requestRegistration({
      baseUrl: 'https://auth.example.com', tenantId: 'tenant-local',
      email: 'new@acme.test', password: 'pw', inviteCode: 'BAD', fetchImpl: impl
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RegisterError);
    expect(err.code).toBe('invalid_invite');
    expect(err.status).toBe(403);
  });
});
