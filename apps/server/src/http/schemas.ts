import { z } from 'zod';
import { JOB_STATUSES } from '../domain/job-state.js';
import { API_KEY_SCOPES, PROJECT_ROLES } from '../modules/auth/principal.js';
import { JOB_EVENT_TYPES } from '../modules/jobs/model.js';

/** Response schemas. They document the API (OpenAPI) and constrain what the serializer may emit. */

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.string(),
    requestId: z.string(),
    errors: z.unknown().optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });

export const IdParam = z.object({ projectId: z.uuid() });
export const JobIdParams = z.object({ projectId: z.uuid(), jobId: z.uuid() });

const JobErrorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });

export const BackoffOut = z.object({
  type: z.enum(['exponential', 'fixed']),
  baseDelayMs: z.number(),
  maxDelayMs: z.number(),
});

export const JobSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    type: z.string(),
    queue: z.string(),
    status: z.enum(JOB_STATUSES),
    payload: z.unknown().describe('Omitted (null) in list responses'),
    result: z.unknown(),
    lastError: JobErrorSchema.nullable(),
    idempotencyKey: z.string().nullable(),
    correlationId: z.string().nullable(),
    maxAttempts: z.number().int(),
    attemptCount: z.number().int(),
    runAttempts: z.number().int(),
    backoff: BackoffOut,
    timeoutMs: z.number().int(),
    runAt: z.string(),
    scheduledJobId: z.string().nullable(),
    lockedBy: z.string().nullable(),
    leaseExpiresAt: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    queuedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: 'Job' });

export const AttemptSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    attemptNumber: z.number().int(),
    workerId: z.string(),
    status: z.enum(['running', 'succeeded', 'failed', 'timed_out', 'lost']),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    queueWaitMs: z.number().nullable(),
    error: JobErrorSchema.nullable(),
  })
  .meta({ id: 'JobAttempt' });

export const EventDataSchema = z.object({
  from: z.enum(JOB_STATUSES).nullable(),
  to: z.enum(JOB_STATUSES),
  type: z.string(),
  queue: z.string(),
  attempt: z.number().int().optional(),
  workerId: z.string().optional(),
  durationMs: z.number().optional(),
  queueWaitMs: z.number().optional(),
  delayMs: z.number().optional(),
  runAt: z.string().optional(),
  error: JobErrorSchema.optional(),
  reason: z.string().optional(),
});

export const EventSchema = z
  .object({
    cursor: z.string(),
    id: z.string(),
    projectId: z.string(),
    jobId: z.string(),
    type: z.enum(JOB_EVENT_TYPES),
    data: EventDataSchema,
    createdAt: z.string(),
  })
  .meta({ id: 'JobEvent' });

export const UserSchema = z
  .object({ id: z.string(), email: z.string(), name: z.string(), createdAt: z.string() })
  .meta({ id: 'User' });

export const MembershipSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  role: z.enum(PROJECT_ROLES),
});

export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    role: z.enum(PROJECT_ROLES).nullable(),
  })
  .meta({ id: 'Project' });

export const MemberSchema = z
  .object({
    userId: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.enum(PROJECT_ROLES),
    createdAt: z.string(),
  })
  .meta({ id: 'ProjectMember' });

export const ApiKeySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    rotatedFrom: z.string().nullable(),
  })
  .meta({ id: 'ApiKey' });

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const errorResponses = {
  400: ProblemSchema,
  401: ProblemSchema,
  403: ProblemSchema,
  404: ProblemSchema,
  409: ProblemSchema,
  422: ProblemSchema,
  429: ProblemSchema,
  503: ProblemSchema,
};
