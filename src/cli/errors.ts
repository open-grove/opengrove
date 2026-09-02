export type OpenGroveCliErrorType = "validation" | "authentication" | "config" | "network" | "internal";

export class OpenGroveCliError extends Error {
  constructor(
    readonly type: OpenGroveCliErrorType,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "OpenGroveCliError";
  }
}
