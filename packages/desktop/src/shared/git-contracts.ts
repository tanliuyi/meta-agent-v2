/**
 * Git 源代码管理契约。
 *
 * 模型对齐 VS Code 的 SCM 架构（src/vs/workbench/contrib/scm/common/scm.ts）：
 * - GitRepositoryState  对应 ISCMRepository（仓库 + HEAD + 分组）
 * - GitResourceGroup    对应 ISCMResourceGroup（如"暂存的更改"）
 * - GitChange           对应 ISCMResource（单个文件变更）
 */

/** 变更类型，对应 VS Code extensions/git 的 Status 枚举映射后的语义。 */
export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "untracked";

/** 单个文件变更（对应 ISCMResource）。indexKind 为暂存区状态，worktreeKind 为工作区状态。 */
export interface GitChange {
  /** 相对仓库根目录的路径（正斜杠）。 */
  path: string;
  /** 重命名/复制时的原路径。 */
  originalPath?: string;
  indexKind?: GitChangeKind;
  worktreeKind?: GitChangeKind;
}

/** 资源组（对应 ISCMResourceGroup），顺序与 VS Code scmViewPane 渲染顺序一致。 */
export interface GitResourceGroup {
  kind: "merge" | "staged" | "unstaged" | "untracked";
  changes: GitChange[];
}

/** 仓库状态快照（对应 ISCMRepository 的序列化形态）。 */
export interface GitRepositoryState {
  projectId: string;
  /** 仓库根目录。 */
  root: string;
  /** 当前分支名；分离 HEAD 时为提交短哈希。 */
  branch: string;
  /** HEAD 提交短哈希。 */
  head: string;
  /** 与上游的领先/落后提交数。 */
  ahead: number;
  behind: number;
  groups: GitResourceGroup[];
  hasConflicts: boolean;
  totalChanges: number;
}

export type GitStatusResult =
  | { ok: true; state: GitRepositoryState }
  | { ok: false; reason: "not-a-repo" | "git-missing" | "error"; message: string };

/** stage/unstage/discard 的目标；paths 为空数组表示作用于全部变更。 */
export interface GitPathsInput {
  projectId: string;
  paths?: string[];
}

export interface GitCommitInput {
  projectId: string;
  message: string;
}

export type GitCommitResult = { ok: true } | { ok: false; message: string };

/** 单个文件的 diff 请求；staged 表示对比 index 与 HEAD（否则对比工作区与 index）。 */
export interface GitDiffInput {
  projectId: string;
  path: string;
  staged: boolean;
}

/** 可操作的 diff 块；id 绑定服务端生成的当前 patch 内容，用于拒绝过期操作。 */
export interface GitDiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** 单个文件的完整上下文 unified diff；hunks 保留零上下文的独立操作边界。 */
export type GitDiffResult =
  | { ok: true; patch: string; hunks: GitDiffHunk[] }
  | { ok: false; reason: "no-diff" | "too-large"; message: string }
  | { ok: false; reason: "error"; message: string };

export type GitHunkAction = "stage" | "unstage" | "discard";

export interface GitHunkActionInput {
  projectId: string;
  path: string;
  hunkId: string;
  action: GitHunkAction;
  /** 未跟踪文件使用 `git diff --no-index` 重新定位待暂存块。 */
  untracked?: boolean;
}

export type GitHunkActionResult = { ok: true } | { ok: false; reason: "stale" | "error"; message: string };
