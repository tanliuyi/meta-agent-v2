export function parseRetryAfterMs(value: string | null, capMs: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), capMs);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), capMs);
  }
  return 0;
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
