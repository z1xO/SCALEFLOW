import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asKey, asUser, createTenant, createTestContext, createUser, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let jobOfA: string;

beforeAll(async () => {
  ctx = await createTestContext();
  a = await createTenant(ctx.services);
  b = await createTenant(ctx.services);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/projects/${a.projectId}/jobs`,
    headers: asKey(a.apiKey),
    payload: { type: 'demo.echo', payload: { message: 'secret of A' } },
  });
  jobOfA = res.json().job.id;
});
afterAll(async () => {
  await ctx.close();
});

/**
 * Cross-tenant access must be indistinguishable from "does not exist" (404), whichever
 * identifier the attacker swaps: project id in the path, job id, or both.
 */
describe('tenant isolation', () => {
  const jobPaths = (projectId: string, jobId: string) => [
    `/v1/projects/${projectId}/jobs/${jobId}`,
    `/v1/projects/${projectId}/jobs/${jobId}/attempts`,
    `/v1/projects/${projectId}/jobs/${jobId}/events`,
  ];

  it("project B's API key cannot read project A by changing the project id", async () => {
    for (const url of [
      `/v1/projects/${a.projectId}`,
      `/v1/projects/${a.projectId}/jobs`,
      `/v1/projects/${a.projectId}/events`,
      ...jobPaths(a.projectId, jobOfA),
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: asKey(b.apiKey) });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('secret of A');
    }
  });

  it("project B cannot reach A's job through B's own project path", async () => {
    for (const url of jobPaths(b.projectId, jobOfA)) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: asKey(b.apiKey) });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("project B cannot cancel or retry A's job", async () => {
    for (const action of ['cancel', 'retry']) {
      for (const projectId of [a.projectId, b.projectId]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/jobs/${jobOfA}/${action}`,
          headers: asKey(b.apiKey),
        });
        expect(res.statusCode, `${action} via ${projectId === a.projectId ? 'A' : 'B'}`).toBe(404);
      }
    }
    const still = await ctx.services.jobQueries.get(a.projectId, jobOfA);
    expect(still.status).toBe('queued');
  });

  it("project B cannot submit jobs into A", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${a.projectId}/jobs`,
      headers: asKey(b.apiKey),
      payload: { type: 'demo.echo', payload: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a user who is not a member sees 404 for the project and its keys', async () => {
    const outsider = await createUser(ctx.services);
    for (const url of [`/v1/projects/${a.projectId}`, `/v1/projects/${a.projectId}/api-keys`, `/v1/projects/${a.projectId}/jobs/${jobOfA}`]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: asUser(outsider) });
      expect(res.statusCode, url).toBe(404);
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/projects', headers: asUser(outsider) });
    expect(list.json().items).toEqual([]);
  });

  it('roles: a viewer can read but not write; only owners manage keys', async () => {
    const viewer = await createUser(ctx.services);
    const dev = await createUser(ctx.services);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${a.projectId}/members`,
      headers: asUser(a.user),
      payload: { email: viewer.email, role: 'viewer' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${a.projectId}/members`,
      headers: asUser(a.user),
      payload: { email: dev.email, role: 'developer' },
    });

    expect((await ctx.app.inject({ method: 'GET', url: `/v1/projects/${a.projectId}/jobs/${jobOfA}`, headers: asUser(viewer) })).statusCode).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectId}/jobs`,
          headers: asUser(viewer),
          payload: { type: 'demo.echo', payload: {} },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/projects/${a.projectId}/jobs`,
          headers: asUser(dev),
          payload: { type: 'demo.echo', payload: {} },
        })
      ).statusCode,
    ).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/projects/${a.projectId}/api-keys`, headers: asUser(dev) })).statusCode).toBe(403);

    // Removing a member revokes access right away (membership cache is invalidated).
    await ctx.app.inject({ method: 'DELETE', url: `/v1/projects/${a.projectId}/members/${viewer.id}`, headers: asUser(a.user) });
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/projects/${a.projectId}/jobs/${jobOfA}`, headers: asUser(viewer) })).statusCode).toBe(404);
  });

  it('a project keeps at least one owner', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${b.projectId}/members/${b.user.id}`,
      headers: asUser(b.user),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('last_owner');
  });
});
