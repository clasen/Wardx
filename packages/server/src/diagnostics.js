function errorFields(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  const out = { name: error.name, message: error.message };
  if (typeof error.code === 'string') out.code = error.code;
  return out;
}

export function createDiagnostics(config, write = (line) => process.stderr.write(line)) {
  const sink = config.diagnostics.sink;
  return {
    report(type, error, details = {}) {
      if (sink === 'none') return;
      const record = {
        ts: Date.now(),
        type,
        error: errorFields(error),
        ...details
      };
      try {
        write(`${JSON.stringify(record)}\n`);
      } catch {
        // Diagnostics must never fail the request or persistence path.
      }
    }
  };
}
