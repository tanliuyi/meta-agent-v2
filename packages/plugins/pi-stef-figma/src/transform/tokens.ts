export function summarizeLibraryPayload(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  const value = record[key];
  if (Array.isArray(value)) {
    return { count: value.length, items: value.slice(0, 100) };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return { count: entries.length, items: Object.fromEntries(entries.slice(0, 100)) };
  }
  return payload;
}
