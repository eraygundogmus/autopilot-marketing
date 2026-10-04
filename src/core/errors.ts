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

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutopilotError';
    this.code = code;
    this.retryable = options.retryable ?? code === 'rate_limited';
    this.hint = options.hint;
  }
}

export function toAutopilotError(error: unknown): AutopilotError {
  if (error instanceof AutopilotError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AutopilotError('internal', message, { cause: error });
}
