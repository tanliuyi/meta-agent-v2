import { describe, expect, it, vi } from "vitest";
import { BrowserCapabilityPort } from "../src/main/session/browser-capability-port.ts";
import { WorkspaceMutationPort } from "../src/main/session/workspace-mutation-port.ts";

describe("bootstrap ports", () => {
  it("rejects use before binding and duplicate binding", async () => {
    const workspace = new WorkspaceMutationPort();
    expect(() => workspace.beginTerminalRestore(["project"])).toThrow("not bound");
    const beginWorkspaceRestore = vi.fn(async () => () => undefined);
    const workspaceTarget = { beginWorkspaceRestore };
    workspace.bind(workspaceTarget);
    await expect(workspace.beginTerminalRestore(["project"])).resolves.toBeTypeOf("function");
    expect(() => workspace.bind({ beginWorkspaceRestore })).toThrow("already bound");
    expect(() => workspace.unbind({ beginWorkspaceRestore })).toThrow("does not match");
    workspace.unbind(workspaceTarget);
    expect(() => workspace.beginTerminalRestore(["project"])).toThrow("not bound");
    expect(() => workspace.bind(workspaceTarget)).toThrow("already bound");

    const browser = new BrowserCapabilityPort();
    expect(() => browser.register({ projectId: "project", threadId: "thread" })).toThrow("not bound");
    const target = { registerSession: vi.fn(() => "token"), revokeSessionCapability: vi.fn() };
    browser.bind(target);
    expect(browser.register({ projectId: "project", threadId: "thread" })).toBe("token");
    browser.revoke({ projectId: "project", threadId: "thread" }, "token");
    expect(target.revokeSessionCapability).toHaveBeenCalledWith("token");
    expect(() => browser.bind(target)).toThrow("already bound");
    browser.unbind(target);
    expect(browser.register({ projectId: "project", threadId: "thread" })).toBeUndefined();
    expect(() => browser.revoke({ projectId: "project", threadId: "thread" }, "token")).not.toThrow();
    expect(() => browser.bind(target)).toThrow("already bound");
  });
});
