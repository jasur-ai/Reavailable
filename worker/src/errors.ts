/**
 * Errors that are safe to return to clients.
 *
 * Every error carries a stable machine-readable `code`; the mobile app translates codes into
 * wording for the user. Messages never contain transcript text or credentials.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }

  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function unauthorized(message = 'A bearer token is required.'): HttpError {
  return new HttpError(401, 'unauthorized', message);
}

export function notFound(message: string, code = 'not_found'): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(message: string, code = 'conflict'): HttpError {
  return new HttpError(409, code, message);
}

export function validationFailed(message: string, code = 'validation_error'): HttpError {
  return new HttpError(422, code, message);
}

export function payloadTooLarge(message: string, code = 'payload_too_large'): HttpError {
  return new HttpError(413, code, message);
}

export function internal(message = 'An unexpected error stopped the request.'): HttpError {
  return new HttpError(500, 'internal_error', message);
}

/** The operator settings are incomplete, for example the speech key is missing. */
export function misconfigured(message: string): HttpError {
  return new HttpError(503, 'server_misconfigured', message);
}
