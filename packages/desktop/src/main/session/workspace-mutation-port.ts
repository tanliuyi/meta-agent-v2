/** TerminalSupervisor 暴露给 session worker 的工作区恢复接口。 */
export interface TerminalWorkspaceMutationTarget {
  beginWorkspaceRestore(projectIds: readonly string[]): Promise<() => void>;
}

/** Session worker 到 TerminalSupervisor 的一次性可绑定端口。 */
export class WorkspaceMutationPort {
  private target: TerminalWorkspaceMutationTarget | undefined;
  private bound = false;

  /** 绑定唯一 terminal 目标。 */
  bind(target: TerminalWorkspaceMutationTarget): void {
    if (this.bound) throw new Error("Workspace mutation port is already bound");
    this.bound = true;
    this.target = target;
  }

  /** 撤销当前 terminal 目标，阻止退出后的新恢复请求。 */
  unbind(target: TerminalWorkspaceMutationTarget): void {
    if (this.target !== target) throw new Error("Workspace mutation port target does not match");
    this.target = undefined;
  }

  /** 开始指定项目的 terminal workspace 恢复并返回结束回调。 */
  beginTerminalRestore(projectIds: readonly string[]): Promise<() => void> {
    if (!this.target) throw new Error("Workspace mutation port is not bound");
    return this.target.beginWorkspaceRestore(projectIds);
  }
}
