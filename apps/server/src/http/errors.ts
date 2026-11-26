export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
export const badRequest = (m: string, code = 'BAD_REQUEST') => new HttpError(400, code, m);
export const unauthorized = (m = 'Please sign in.') => new HttpError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You do not have permission to do that.', code = 'FORBIDDEN') => new HttpError(403, code, m);
export const notFound = (m = 'Not found.') => new HttpError(404, 'NOT_FOUND', m);
export const conflict = (m: string, code = 'CONFLICT') => new HttpError(409, code, m);
export const tooMany = (m = 'Too many requests. Please slow down.') => new HttpError(429, 'RATE_LIMITED', m);
