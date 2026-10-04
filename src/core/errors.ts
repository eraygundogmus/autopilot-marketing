export type ErrorCode =
  | 'config_invalid'
  | 'not_configured'
  | 'not_found'
  | 'invalid_input'
  | 'unsupported'
  | 'policy_denied'
  | 'approval_required'
  | 'approval_invalid'
  | 'stale_state'
  | 'kill_switch'
  | 'platform_error'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'internal';

/** The only error type that crosses a module boundary. `hint` tells the caller what to do next. */
export class AutopilotError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  /** HTTP status of the platform response this error came from, when there was one. */
  readonly status: number | undefined;
  /** The platform's response body, secrets redacted and cut to a few thousand characters. Never shown as it is. */
  readonly body: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; hint?: string; cause?: unknown; status?: number; body?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutopilotError';
    this.code = code;
    this.retryable = options.retryable ?? code === 'rate_limited';
    this.hint = options.hint;
    this.status = options.status;
    this.body = options.body;
  }
}

export function toAutopilotError(error: unknown): AutopilotError {
  if (error instanceof AutopilotError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AutopilotError('internal', message, { cause: error });
}
