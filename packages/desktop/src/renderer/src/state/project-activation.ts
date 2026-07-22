import type { Project } from "../../../shared/contracts.ts";

interface PendingActivation {
  projectId: string;
  promise: Promise<void>;
}

/** Serializes ProjectStore.open while ensuring the latest route intent wins. */
export class ProjectActivationCoordinator {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending: PendingActivation | null = null;

  activate(
    projectId: string,
    isActive: () => boolean,
    open: (targetProjectId: string) => Promise<Project>,
    commit: (project: Project) => void,
  ): Promise<void> {
    if (this.pending?.projectId === projectId) return this.pending.promise;
    if (!this.pending && isActive()) return Promise.resolve();

    const mustOpen = this.pending !== null || !isActive();
    const generation = ++this.generation;
    const task = this.tail.then(async () => {
      if (generation !== this.generation) return;
      if (!mustOpen && isActive()) return;

      let project: Project;
      try {
        project = await open(projectId);
      } catch (error) {
        if (generation !== this.generation) return;
        throw error;
      }
      if (generation === this.generation) commit(project);
    });

    this.pending = { projectId, promise: task };
    this.tail = task.catch(() => undefined);
    void task.then(
      () => {
        if (this.pending?.promise === task) this.pending = null;
      },
      () => {
        if (this.pending?.promise === task) this.pending = null;
      },
    );
    return task;
  }
}
