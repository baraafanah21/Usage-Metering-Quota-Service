/**
 * An expected failure with a stable machine-readable code. The error middleware turns it
 * into an application/problem+json response (DESIGN.md §8). Anything that is not an
 * AppError is treated as a bug and reported as a generic 500.
 */
export class AppError extends Error {
  override name = "AppError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ?? title, options);
  }
}
