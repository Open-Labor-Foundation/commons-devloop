export function log(level, message, context = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
