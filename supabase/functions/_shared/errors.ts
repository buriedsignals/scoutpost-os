/**
 * Typed exception hierarchy for Edge Functions.
 *
 * Handlers throw these; the responses module converts them to JSON responses
 * with the correct HTTP status code. Unknown exceptions become 500.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class AuthError extends ApiError {
  constructor(message = "unauthorized") {
    super(message, 401, "unauthorized");
    this.name = "AuthError";
  }
}

export class AdmissionError extends ApiError {
  constructor(message = "Indicator access is no longer available") {
    super(message, 403, "indicator_access_required");
    this.name = "AdmissionError";
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "not_found");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(message, 400, "validation_error");
    this.name = "ValidationError";
  }
}

export class RateLimitError extends ApiError {
  constructor(message = "rate limit exceeded") {
    super(message, 429, "rate_limit");
    this.name = "RateLimitError";
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409, "conflict");
    this.name = "ConflictError";
  }
}
