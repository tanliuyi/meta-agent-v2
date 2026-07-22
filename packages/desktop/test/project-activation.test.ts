import { describe, expect, it, vi } from "vitest";
import { ProjectActivationCoordinator } from "../src/renderer/src/state/project-activation.ts";
import type { Project } from "../src/shared/contracts.ts";

const projects = {
  a: project("a"),
  b: project("b"),
};

describe("ProjectActivationCoordinator", () => {
  it("serializes ProjectStore.open and lets the latest route intent win", async () => {
    const coordinator = new ProjectActivationCoordinator();
    const firstOpen = deferred<Project>();
    const opened: string[] = [];
    const committed: string[] = [];
    let activeProjectId = "a";
    const open = vi.fn(async (projectId: string) => {
      opened.push(projectId);
      const next = projectId === "b" && opened.length === 1 ? await firstOpen.promise : projects.a;
      activeProjectId = next.id;
      return next;
    });
    const commit = (next: Project) => {
      activeProjectId = next.id;
      committed.push(next.id);
    };

    const activateB = coordinator.activate("b", () => activeProjectId === "b", open, commit);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("b"));
    const activateA = coordinator.activate("a", () => activeProjectId === "a", open, commit);
    firstOpen.resolve(projects.b);

    await Promise.all([activateB, activateA]);

    expect(opened).toEqual(["b", "a"]);
    expect(committed).toEqual(["a"]);
    expect(activeProjectId).toBe("a");
  });

  it("deduplicates repeated activation of the same pending Project", async () => {
    const coordinator = new ProjectActivationCoordinator();
    const pending = deferred<Project>();
    const open = vi.fn(() => pending.promise);
    const commit = vi.fn();

    const first = coordinator.activate("b", () => false, open, commit);
    const second = coordinator.activate("b", () => false, open, commit);
    pending.resolve(projects.b);
    await Promise.all([first, second]);

    expect(open).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });
});

function project(id: string): Project {
  return {
    id,
    name: id,
    cwd: `/workspace/${id}`,
    lastOpenedAt: 1,
    available: true,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
