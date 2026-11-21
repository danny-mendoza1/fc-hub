/** An error that becomes a JSON error response with this status (see app.ts dispatch). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}
