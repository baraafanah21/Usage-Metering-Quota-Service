/** One JSON line per event, like the API's logs. Never pass API keys in `fields`. */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  (level === "info" ? console.log : console.error)(line);
}
