export function textResult<T>(text: string, details: T): { content: Array<{ type: 'text'; text: string }>; details: T } {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

export function cappedJson(value: unknown, maxChars = 40_000): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n... truncated at ${maxChars} characters`;
}
