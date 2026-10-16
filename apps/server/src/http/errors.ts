import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError, ServiceUnavailableError, TooManyRequestsError } from '../lib/errors.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  errors?: unknown,
): FastifyReply {
  return reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `urn:scaleflow:problem:${code}`,
      title: TITLES[status] ?? 'Error',
      status,
      detail,
      code,
      requestId: request.id,
      ...(errors === undefined ? {} : { errors }),
    });
}

/**
 * Every error leaves the API as RFC 9457 problem details with a stable `code` and the request id.
 * Unexpected errors are logged with their stack and returned as a generic 500 - internal details
 * (SQL, stack traces, hostnames) never reach the client.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | Error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return sendProblem(
        reply,
        request,
        400,
        'validation_failed',
        'Request validation failed',
        err.validation.map((v) => ({
          location: err.validationContext,
          path: v.instancePath,
          message: v.message,
        })),
      );
    }
    if (err instanceof AppError) {
      if (err instanceof TooManyRequestsError || (err instanceof ServiceUnavailableError && err.retryAfterSeconds)) {
        void reply.header('retry-after', String(err.retryAfterSeconds));
      }
      if (err.statusCode >= 500) request.log.error({ err }, 'request failed');
      return sendProblem(reply, request, err.statusCode, err.code, err.message, err.details);
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err, cause: err.cause }, 'response failed schema serialization');
      return sendProblem(reply, request, 500, 'internal_error', 'Internal server error');
    }
    const fastifyErr = err as FastifyError;
    if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendProblem(reply, request, 413, 'payload_too_large', 'Request body is too large');
    }
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      // Framework-level client errors (malformed JSON, wrong content type, ...): messages are safe.
      return sendProblem(
        reply,
        request,
        fastifyErr.statusCode,
        (fastifyErr.code || 'bad_request').toLowerCase(),
        fastifyErr.message,
      );
    }
    request.log.error({ err }, 'unhandled error');
    return sendProblem(reply, request, 500, 'internal_error', 'Internal server error');
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request, 404, 'route_not_found', `Route ${request.method} ${request.url.split('?')[0] ?? ''} not found`),
  );
}
