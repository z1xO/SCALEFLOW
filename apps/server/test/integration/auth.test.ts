import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asKey,
  asUser,
  createApiKey,
  createTenant,
  createTestContext,
  createUser,
  ORIGIN,
  type TestContext,
} from '../helpers/context.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('registration and sessions', () => {
  it('registers, logs in with an HttpOnly cookie, reads /me, logs out', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'Alice@Example.test', password: 'a-long-password', name: 'Alice' },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user).not.toHaveProperty('passwordHash');

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'alice@example.test', password: 'a-long-password' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/sf_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = setCookie.split(';')[0] ?? '';

    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('Alice@Example.test');

    const out = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });
    expect(out.statusCode).toBe(204);
    const after = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    const body = { email: 'dup@example.test', password: 'a-long-password', name: 'Dup' };
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/auth/register', payload: body })).statusCode,
    ).toBe(201);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...body, email: 'DUP@example.test' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('email_taken');
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const user = await createUser(ctx.services);
    const wrongPw = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'not-the-password' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.test', password: 'not-the-password' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrongPw.json().detail).toBe(unknown.json().detail);
  });

  it('validates input and never echoes passwords', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short', name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).not.toContain('short');
    expect(res.json().code).toBe('validation_failed');
  });

  it('rejects cookie-authenticated writes from a foreign Origin (CSRF)', async () => {
    const user = await createUser(ctx.services);
    const evil = await ctx.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: user.cookie, origin: 'https://evil.example' },
      payload: { name: 'x' },
    });
    expect(evil.statusCode).toBe(403);
    const noOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie: user.cookie },
      payload: { name: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: asUser(user),
      payload: { name: 'x' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('API keys', () => {
  it('returns the secret once and stores only a hash', async () => {
    const { user, projectId } = await createTenant(ctx.services);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/api-keys`,
      headers: asUser(user),
      payload: { name: 'deploy' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { secret, apiKey } = res.json();
    expect(secret).toMatch(/^sf_[A-Za-z0-9_-]{43}$/);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/api-keys`,
      headers: asUser(user),
    });
    expect(list.body).not.toContain(secret);
    const { rows } = await ctx.services.pool.query(
      'SELECT key_hash, key_prefix FROM api_keys WHERE id = $1',
      [apiKey.id],
    );
    expect(rows[0].key_prefix).toBe(secret.slice(0, 11));
    expect(Buffer.isBuffer(rows[0].key_hash)).toBe(true);
    expect(rows[0].key_hash.toString('utf8')).not.toContain(secret);
  });

  it('revocation takes effect immediately, even with a warm auth cache', async () => {
    const { user, projectId, apiKey } = await createTenant(ctx.services);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/jobs`,
      headers: asKey(apiKey),
    });
    expect(ok.statusCode).toBe(200); // cache is now warm
    const keys = (await ctx.services.apiKeys.list(projectId))[0];
    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/api-keys/${keys!.id}`,
      headers: asUser(user),
    });
    expect(revoke.statusCode).toBe(200);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/jobs`,
      headers: asKey(apiKey),
    });
    expect(denied.statusCode).toBe(401);
  });

  it('rotation issues a new key and keeps the old one only for the grace period', async () => {
    const { user, projectId, apiKey } = await createTenant(ctx.services);
    const keyId = (await ctx.services.apiKeys.list(projectId))[0]!.id;
    const rot = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/api-keys/${keyId}/rotate`,
      headers: asUser(user),
      payload: { gracePeriodSeconds: 0 },
    });
    expect(rot.statusCode).toBe(201);
    const { secret: newSecret, apiKey: newKey } = rot.json();
    expect(newKey.rotatedFrom).toBe(keyId);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/v1/projects/${projectId}/jobs`, headers: asKey(apiKey) }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/jobs`,
          headers: asKey(newSecret),
        })
      ).statusCode,
    ).toBe(200);

    // With a grace period, both keys work.
    const rot2 = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/api-keys/${newKey.id}/rotate`,
      headers: asUser(user),
      payload: { gracePeriodSeconds: 3600 },
    });
    expect(rot2.json().previous.expiresAt).not.toBeNull();
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/jobs`,
          headers: asKey(newSecret),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('enforces scopes: a read-only key cannot submit jobs', async () => {
    const { user, projectId } = await createTenant(ctx.services);
    const readOnly = await createApiKey(ctx.services, projectId, user, ['jobs:read']);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/jobs`,
      headers: asKey(readOnly),
      payload: { type: 'demo.echo', payload: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/jobs`,
          headers: asKey(readOnly),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('API keys cannot manage keys or call user-only endpoints', async () => {
    const { projectId, apiKey } = await createTenant(ctx.services);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/api-keys`,
          headers: asKey(apiKey),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/projects', headers: asKey(apiKey) })).statusCode,
    ).toBe(403);
  });

  it('rejects malformed and unknown bearer tokens', async () => {
    const { projectId } = await createTenant(ctx.services);
    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/jobs`,
      headers: { authorization: 'Bearer sf_doesnotexist' },
    });
    expect(bad.statusCode).toBe(401);
    const malformed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/jobs`,
      headers: { authorization: 'Basic abc' },
    });
    expect(malformed.statusCode).toBe(401);
  });
});
