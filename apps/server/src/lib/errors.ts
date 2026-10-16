/**
 * Application errors carry an HTTP status and a stable machine-readable `code`. They are mapped to
 * RFC 9457 problem details by the HTTP layer. Anything that is not an AppError is treated as an
 * internal error: logged with its stack, returned to the client as a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_failed', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'not_found', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(429, code, message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string) {
    super(503, code, message);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
