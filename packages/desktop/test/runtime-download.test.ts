import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpsMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("node:https", () => ({ get: httpsMock.get }));

import { downloadRuntimeArchive } from "../src/main/sidecar/runtime-download.ts";

describe("runtime archive download", () => {
  let root: string;

  beforeEach(() => {
    httpsMock.get.mockReset();
    root = mkdtempSync(join(tmpdir(), "desktop-runtime-download-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a malformed redirect without escaping the promise", async () => {
    const response = fakeResponse(302, { location: "http://[" });
    httpsMock.get.mockImplementation((_url, callback: (message: IncomingMessage) => void) => {
      const request = fakeRequest();
      setImmediate(() => callback(response));
      return request;
    });

    await expect(
      downloadRuntimeArchive("https://example.test/archive", join(root, "archive"), "Runtime", () => {}),
    ).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it("closes and removes a partial file after a response stream error", async () => {
    const response = fakeResponse(200, { "content-length": "100" });
    httpsMock.get.mockImplementation((_url, callback: (message: IncomingMessage) => void) => {
      const request = fakeRequest();
      setImmediate(() => {
        callback(response);
        setImmediate(() => response.emit("error", new Error("source failed")));
      });
      return request;
    });
    const destination = join(root, "archive");

    await expect(
      downloadRuntimeArchive("https://example.test/archive", destination, "Runtime", () => {}),
    ).rejects.toThrow("source failed");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

function fakeRequest(): ClientRequest {
  const request = new EventEmitter() as ClientRequest;
  request.setTimeout = () => request;
  request.destroy = () => request;
  return request;
}

function fakeResponse(statusCode: number, headers: IncomingMessage["headers"]): IncomingMessage {
  const response = new PassThrough() as unknown as IncomingMessage;
  response.statusCode = statusCode;
  response.headers = headers;
  response.setTimeout = () => response;
  response.resume = () => response;
  response.destroy = () => response;
  return response;
}
