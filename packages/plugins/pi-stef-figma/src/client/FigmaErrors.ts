export class FigmaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}

export function describeFigmaStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'Check the Figma token and required REST scopes.';
  }
  if (status === 404) {
    return 'Check the file key, node ID, and token access to the file.';
  }
  if (status === 429) {
    return 'Figma rate limit reached. Retry later or narrow the request with ids/depth.';
  }
  if (status === 413) {
    return 'Figma request was too large. Use ids and depth filters.';
  }
  return 'Figma API request failed.';
}
