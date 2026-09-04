/** 应用退出时按依赖顺序执行的资源阶段。 */
export type ResourceShutdownPhase = "background" | "browser" | "workspace" | "session" | "logging";

/** 可由资源作用域统一关闭的资源。 */
export interface DisposableResource {
  dispose(): void | Promise<void>;
}

interface RegisteredResource {
  readonly name: string;
  readonly phase: ResourceShutdownPhase;
  readonly resource: DisposableResource;
}

const SHUTDOWN_PHASES: readonly ResourceShutdownPhase[] = ["background", "browser", "workspace", "session", "logging"];

/** 按依赖感知阶段释放主进程资源；同阶段并行，失败不阻断后续阶段。 */
export class ResourceScope implements DisposableResource {
  private readonly resources: RegisteredResource[] = [];
  private disposal: Promise<void> | undefined;

  /** 注册一个具名资源；同名资源和退出开始后的注册都会被拒绝。 */
  add(name: string, phase: ResourceShutdownPhase, resource: DisposableResource): void {
    if (this.disposal) throw new Error("Cannot register a resource after disposal started");
    if (this.resources.some((entry) => entry.name === name)) throw new Error(`Resource is already registered: ${name}`);
    this.resources.push({ name, phase, resource });
  }

  /** 幂等执行分阶段释放，并聚合所有资源错误。 */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    return this.disposal;
  }

  private async disposeOnce(): Promise<void> {
    const errors: unknown[] = [];
    for (const phase of SHUTDOWN_PHASES) {
      const results = await Promise.allSettled(
        this.resources
          .filter((entry) => entry.phase === phase)
          .map(async (entry) => {
            try {
              await entry.resource.dispose();
            } catch (error) {
              throw new Error(`Failed to dispose ${entry.name}`, { cause: error });
            }
          }),
      );
      errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose application resources");
  }
}
