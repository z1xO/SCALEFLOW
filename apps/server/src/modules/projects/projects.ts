import type pg from 'pg';
import { z } from 'zod';
import { withTransaction, pgErrorCode, PgErrorCode } from '../../infra/db/pool.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { Authorizer, ProjectRole } from '../auth/principal.js';
import { PROJECT_ROLES } from '../auth/principal.js';
import type { Actor } from '../jobs/model.js';
import { writeAudit } from '../jobs/write-helpers.js';

export const CreateProjectSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const UpdateProjectSchema = CreateProjectSchema;
export const AddMemberSchema = z.object({
  email: z.email(),
  role: z.enum(PROJECT_ROLES).default('developer'),
});

export interface ProjectDto {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  role: ProjectRole | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
  createdAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  role?: ProjectRole | null;
}

const toDto = (r: ProjectRow): ProjectDto => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  role: r.role ?? null,
});

export class ProjectService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly authorizer: Authorizer,
  ) {}

  async create(userId: string, input: z.infer<typeof CreateProjectSchema>): Promise<ProjectDto> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ProjectRow>(
        'INSERT INTO projects (id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
        [uuidv7(), input.name, userId],
      );
      const p = rows[0] as ProjectRow;
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [
        p.id,
        userId,
      ]);
      await writeAudit(client, {
        projectId: p.id,
        actor: { type: 'user', id: userId },
        action: 'project.created',
        targetType: 'project',
        targetId: p.id,
      });
      await this.authorizer.invalidateMembership(userId, p.id);
      return toDto({ ...p, role: 'owner' });
    });
  }

  async listForUser(userId: string): Promise<ProjectDto[]> {
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT p.*, pm.role FROM projects p JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1 ORDER BY p.created_at`,
      [userId],
    );
    return rows.map(toDto);
  }

  async get(projectId: string, role: ProjectRole | null): Promise<ProjectDto> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]);
    const p = rows[0];
    if (!p) throw new NotFoundError('Project');
    return toDto({ ...p, role });
  }

  async rename(
    projectId: string,
    input: z.infer<typeof UpdateProjectSchema>,
    actor: Actor,
  ): Promise<ProjectDto> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ProjectRow>(
        'UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [projectId, input.name],
      );
      const p = rows[0];
      if (!p) throw new NotFoundError('Project');
      await writeAudit(client, {
        projectId,
        actor,
        action: 'project.renamed',
        targetType: 'project',
        targetId: projectId,
        metadata: { name: input.name },
      });
      return toDto({ ...p, role: 'owner' });
    });
  }

  async members(projectId: string): Promise<MemberDto[]> {
    const { rows } = await this.pool.query<{
      user_id: string;
      email: string;
      name: string;
      role: ProjectRole;
      created_at: Date;
    }>(
      `SELECT pm.user_id, u.email, u.name, pm.role, pm.created_at FROM project_members pm
       JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY pm.created_at`,
      [projectId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      name: r.name,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async addMember(
    projectId: string,
    input: z.infer<typeof AddMemberSchema>,
    actor: Actor,
  ): Promise<MemberDto> {
    const member = await withTransaction(this.pool, async (client) => {
      const { rows: users } = await client.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM users WHERE lower(email) = lower($1)',
        [input.email],
      );
      const user = users[0];
      if (!user) throw new UnprocessableError('user_not_found', 'No user with that email has registered');
      try {
        const { rows } = await client.query<{ created_at: Date }>(
          'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) RETURNING created_at',
          [projectId, user.id, input.role],
        );
        await writeAudit(client, {
          projectId,
          actor,
          action: 'project.member_added',
          targetType: 'user',
          targetId: user.id,
          metadata: { role: input.role },
        });
        return {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: input.role,
          createdAt: (rows[0] as { created_at: Date }).created_at.toISOString(),
        };
      } catch (err) {
        if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
          throw new ConflictError('already_member', 'User is already a member of this project');
        }
        throw err;
      }
    });
    await this.authorizer.invalidateMembership(member.userId, projectId);
    return member;
  }

  async removeMember(projectId: string, userId: string, actor: Actor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ role: ProjectRole }>(
        'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING role',
        [projectId, userId],
      );
      const removed = rows[0];
      if (!removed) throw new NotFoundError('Member');
      if (removed.role === 'owner') {
        const { rows: owners } = await client.query(
          "SELECT 1 FROM project_members WHERE project_id = $1 AND role = 'owner' LIMIT 1",
          [projectId],
        );
        if (owners.length === 0)
          throw new ConflictError('last_owner', 'A project must keep at least one owner');
      }
      await writeAudit(client, {
        projectId,
        actor,
        action: 'project.member_removed',
        targetType: 'user',
        targetId: userId,
      });
    });
    await this.authorizer.invalidateMembership(userId, projectId);
  }
}
