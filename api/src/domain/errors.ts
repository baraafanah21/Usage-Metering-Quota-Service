export interface FieldError {
  /** Dotted path to the offending field, "" for the body itself. */
  path: string;
  message: string;
}

/**
 * An expected failure with a stable machine-readable code. The error middleware turns it
 * into an application/problem+json response (DESIGN.md §8). Anything that is not an
 * AppError is treated as a bug and reported as a generic 500.
 */
export class AppError extends Error {
  override name = "AppError";
  readonly errors: FieldError[] | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    options?: { cause?: unknown; errors?: FieldError[] },
  ) {
    super(detail ?? title, options);
    this.errors = options?.errors;
  }
}
