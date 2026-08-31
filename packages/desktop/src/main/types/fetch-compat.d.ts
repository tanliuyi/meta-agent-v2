type DesktopFetchBody = RequestInit["body"] | Uint8Array<ArrayBufferLike>;

declare function fetch(
  input: RequestInfo | URL,
  init?: Omit<RequestInit, "body"> & { body?: DesktopFetchBody },
): Promise<Response>;
