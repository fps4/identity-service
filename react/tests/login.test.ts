import { describe, it, expect } from 'vitest';
import { requestPasswordToken, LoginError } from '../src/password.js';

// A fake fetch that records the request and returns a canned response.
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

describe('requestPasswordToken (RQ-0003)', () => {
  it('POSTs the password grant and maps the token response', async () => {
    const { impl, calls } = fakeFetch(200, {
      access_token: 'jwt-abc', token_type: 'Bearer', expires_in: 900,
      refresh_token: 'r-xyz', refresh_expires_in: 2592000, scope: ''
    });

    const token = await requestPasswordToken({
      baseUrl: 'https://auth.example.com/', clientId: 'client-local',
      username: 'reviewer@fps4.test', password: 'correct-horse-battery', fetchImpl: impl
    });

    expect(token.accessToken).toBe('jwt-abc');
    expect(token.refreshToken).toBe('r-xyz');
    expect(token.tokenType).toBe('Bearer');

    // Hits the token endpoint with a form-encoded password grant (trailing slash normalized).
    expect(calls[0].url).toBe('https://auth.example.com/oauth2/token');
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(calls[0].init.body);
    expect(sent.get('grant_type')).toBe('password');
    expect(sent.get('username')).toBe('reviewer@fps4.test');
    expect(sent.get('client_id')).toBe('client-local');
  });

  it('throws a LoginError carrying the status on a rejected login', async () => {
    const { impl } = fakeFetch(400, { error: 'invalid_grant', error_description: 'Invalid credentials' });
    await expect(requestPasswordToken({
      baseUrl: 'https://auth.example.com', clientId: 'client-local',
      username: 'reviewer@fps4.test', password: 'wrong', fetchImpl: impl
    })).rejects.toMatchObject({ name: 'LoginError', status: 400, message: 'Invalid credentials' });
  });
});
