/**
 * Set-password links (services/password-links.ts, routes/password-routes.ts): an operator issues a
 * link for a user who exists; the person opens it, types a password twice, and holds a password
 * nobody else has seen. Only the token's digest is stored; the link expires; it works once — and
 * the page says the one sentence for every failure of the link itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { Transaction, type Store } from '../src/db/index.js';
import { createPasswordLinkService, passwordLinkDigest } from '../src/services/password-links.js';
import { UserServiceError } from '../src/services/users.js';
import { hashSecret, verifySecret } from '../src/utils/hash.js';
import { testStore, type TestStore } from './helpers/store.js';

const NOW = new Date('2026-09-22T09:00:00Z');
const ISSUER = 'https://id.example.test';

async function withUser(db: TestStore, email = 'person@example.test'): Promise<string> {
  const id = randomUUID();
  const tx = new Transaction();
  db.store.users.put(tx, {
    _id: id, email, passwordHash: hashSecret('temporary-password-1'), identities: [], emailVerified: false,
    status: 'active', failedAttempts: 0, passwordUpdatedAt: NOW, createdAt: NOW, updatedAt: NOW
  });
  await db.store.commit(tx);
  return id;
}

describe('the service', () => {
  let db: TestStore;
  let clock = NOW;
  const service = (store: Store) => createPasswordLinkService({ store, issuer: ISSUER, now: () => clock });

  beforeEach(async () => { db = await testStore(); clock = NOW; });
  afterEach(async () => { await db.drop(); });

  it('issues a link for an existing user: the URL once, the digest stored, the expiry as the TTL', async () => {
    const id = await withUser(db);
    const link = await service(db.store).issue({ email: 'Person@Example.test', createdBy: 'test' });
    expect(link.url).toBe(`${ISSUER}/password?token=${link.token}`);
    expect(link.email).toBe('person@example.test');
    expect(link.expiresAt.toISOString()).toBe('2026-09-23T09:00:00.000Z');
    const stored = await db.store.passwordLinks.get(passwordLinkDigest(link.token));
    expect(stored?.userId).toBe(id);
    expect(stored?.createdBy).toBe('test');
    expect(JSON.stringify(stored)).not.toContain(link.token);
  });

  it('refuses a link for nobody, for a disabled user, or for longer than a week', async () => {
    await expect(service(db.store).issue({ email: 'ghost@example.test' })).rejects.toMatchObject({ code: 'user_not_found' });
    const id = await withUser(db, 'off@example.test');
    await db.store.users.update(id, { status: 'disabled', updatedAt: NOW });
    await expect(service(db.store).issue({ userId: id })).rejects.toMatchObject({ code: 'user_disabled' });
    await withUser(db);
    await expect(service(db.store).issue({ email: 'person@example.test', hours: 24 * 8 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('redeems once: the password set, the link consumed, the address vouched; a second time is the one sentence', async () => {
    const id = await withUser(db);
    const { token } = await service(db.store).issue({ email: 'person@example.test' });
    expect(await service(db.store).peek(token)).toEqual({ email: 'person@example.test' });

    const done = await service(db.store).redeem({ token, password: 'a-fresh-password-1' });
    expect(done.email).toBe('person@example.test');
    const user = await db.store.users.get(id);
    expect(verifySecret('a-fresh-password-1', user!.passwordHash!)).toBe(true);
    expect(verifySecret('temporary-password-1', user!.passwordHash!)).toBe(false);
    expect(user?.emailVerified).toBe(true);
    expect(user?.passwordUpdatedAt?.toISOString()).toBe(NOW.toISOString());

    expect(await service(db.store).peek(token)).toBeNull();
    await expect(service(db.store).redeem({ token, password: 'another-password-1' })).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('an expired link, an unknown token and an empty one are all the one sentence; a weak password is its own', async () => {
    await withUser(db);
    const { token } = await service(db.store).issue({ email: 'person@example.test', hours: 1 });
    clock = new Date(NOW.getTime() + 61 * 60_000);
    expect(await service(db.store).peek(token)).toBeNull();
    await expect(service(db.store).redeem({ token, password: 'a-fresh-password-1' })).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(service(db.store).redeem({ token: 'not-a-token', password: 'a-fresh-password-1' })).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(service(db.store).redeem({ token: '', password: 'a-fresh-password-1' })).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(service(db.store).redeem({ token, password: 'short' })).rejects.toBeInstanceOf(UserServiceError);
    await expect(service(db.store).redeem({ token, password: 'short' })).rejects.toMatchObject({ code: 'weak_password' });
  });

  it('a locked user is unlocked by setting a password through a link', async () => {
    const id = await withUser(db);
    await db.store.users.update(id, { status: 'locked', failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 3600_000), updatedAt: NOW });
    const { token } = await service(db.store).issue({ userId: id });
    await service(db.store).redeem({ token, password: 'a-fresh-password-1' });
    const user = await db.store.users.get(id);
    expect(user?.status).toBe('active');
    expect(user?.failedAttempts).toBe(0);
    expect(user?.lockedUntil).toBeNull();
  });
});

// --- the page: real HTTP, the service stubbed -------------------------------------------------------

const peek = vi.fn<(token: string) => Promise<{ email: string } | null>>();
const redeem = vi.fn<(input: { token: string; password: string }) => Promise<{ email: string }>>();
vi.mock('../src/container.js', () => ({
  passwordLinkService: { peek: (t: string) => peek(t), redeem: (i: { token: string; password: string }) => redeem(i) }
}));
const { default: passwordRoutes } = await import('../src/routes/password-routes.js');

describe('the page', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    peek.mockReset();
    redeem.mockReset();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(passwordRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });
  afterEach(() => { server?.close(); });

  const post = (body: Record<string, string>) =>
    fetch(`${base}/password`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  it('renders the form for a valid link: whose it is, the token hidden, no script, a strict CSP', async () => {
    peek.mockResolvedValue({ email: 'person@example.test' });
    const res = await fetch(`${base}/password?token=abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('person@example.test');
    expect(html).toContain('name="token" value="abc"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).not.toContain('<script');
  });

  it('an invalid link is one page, whatever the reason', async () => {
    peek.mockResolvedValue(null);
    const res = await fetch(`${base}/password?token=nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This link is not valid');
    const none = await fetch(`${base}/password`);
    expect(none.status).toBe(404);
  });

  it('two different passwords are asked again; a redeemed one is done; a weak one says why', async () => {
    peek.mockResolvedValue({ email: 'person@example.test' });
    const differ = await post({ token: 'abc', password: 'a-fresh-password-1', password_confirm: 'a-fresh-password-2' });
    expect(differ.status).toBe(400);
    expect(await differ.text()).toContain('The two passwords differ.');
    expect(redeem).not.toHaveBeenCalled();

    redeem.mockRejectedValueOnce(new UserServiceError('Password must be at least 10 characters', 400, 'weak_password'));
    const weak = await post({ token: 'abc', password: 'short', password_confirm: 'short' });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain('at least 10 characters');

    redeem.mockResolvedValueOnce({ email: 'person@example.test' });
    const done = await post({ token: 'abc', password: 'a-fresh-password-1', password_confirm: 'a-fresh-password-1' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Password set');
    expect(redeem).toHaveBeenCalledWith({ token: 'abc', password: 'a-fresh-password-1' });
  });

  it('escapes what it prints', async () => {
    peek.mockResolvedValue({ email: '<b>x</b>@example.test' });
    const html = await (await fetch(`${base}/password?token=%22%3E%3Cscript%3E`)).text();
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('"><script>');
  });
});
