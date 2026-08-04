import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * bash 注入模板（通过 --rcfile 加载；配合去掉 --login 的 spawn 参数，见 prepareShellInjection）。
 * 自建 login 语义：/etc/profile -> 用户 profile 链 -> ~/.bashrc。原因：bash 的 --rcfile 与
 * --login 不兼容——login shell 不读 rcfile（bashrc 由用户 profile 自行 source），而参数序
 * 列 "-i --rcfile" 还会触发 bash 解析 bug（"invalid option --"，退出码 2）。
 * PROMPT_COMMAND 为数组时无法安全拼接，跳过注入。接管 PROMPT_COMMAND：每次 prompt 前
 * 输出 OSC 633 序列（633;A 上一条命令退出码、633;1 prompt 开始、633;2 命令开始）。
 */
export const BASH_INJECTION = `# Meta Agent shell integration (bash)
# 模拟 login shell 初始化：/etc/profile -> 用户 profile 链 -> ~/.bashrc
if [ -f /etc/profile ]; then
  # shellcheck disable=SC1091
  . /etc/profile
fi
if [ -f "\${HOME}/.bash_profile" ]; then
  # shellcheck disable=SC1090
  . "\${HOME}/.bash_profile"
elif [ -f "\${HOME}/.bash_login" ]; then
  # shellcheck disable=SC1090
  . "\${HOME}/.bash_login"
elif [ -f "\${HOME}/.profile" ]; then
  # shellcheck disable=SC1090
  . "\${HOME}/.profile"
fi
if [ -f "\${HOME}/.bashrc" ]; then
  # shellcheck disable=SC1090
  . "\${HOME}/.bashrc"
fi

# PROMPT_COMMAND 为数组时无法安全拼接，跳过注入（不修改任何配置）
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -"[aA]* ]]; then
  return 0
fi

_meta_agent_original_prompt_command="\${PROMPT_COMMAND:-}"

_meta_agent_prompt_command() {
  local _meta_agent_exit_code=$?
  printf '\\033]633;A;%s\\007' "\${_meta_agent_exit_code}"
  printf '\\033]633;1\\007'
  if [ -n "\${_meta_agent_original_prompt_command:-}" ]; then
    eval "\${_meta_agent_original_prompt_command}"
  fi
  printf '\\033]633;2\\007'
}

PROMPT_COMMAND='_meta_agent_prompt_command'
`;

/**
 * zsh 注入模板（通过 ZDOTDIR 指向的 .zshrc 加载）。
 * 先 source 用户 ~/.zshrc 保留用户配置；通过 precmd_functions 在每次 prompt 前输出 OSC 633 序列。
 */
export const ZSH_INJECTION = `# Meta Agent shell integration (zsh)
# 保留用户配置：先加载用户 ~/.zshrc（若存在）
if [[ -f "\${HOME}/.zshrc" ]]; then
  # shellcheck disable=SC1090
  source "\${HOME}/.zshrc"
fi

_meta_agent_precmd() {
  local _meta_agent_exit_code=$?
  printf '\\033]633;A;%s\\007' "\${_meta_agent_exit_code}"
  printf '\\033]633;1\\007'
  printf '\\033]633;2\\007'
}

precmd_functions+=(_meta_agent_precmd)
`;

export interface ShellInjection {
  args: string[];
  env: Record<string, string | undefined>;
  cleanup: () => void;
}

/** shell 文件 basename 是否为支持注入的 bash/zsh（含 Windows 下的 .exe）。 */
export function isInjectedShell(shellFile: string): boolean {
  const name = basename(shellFile).toLowerCase();
  return name === "bash" || name === "bash.exe" || name === "zsh" || name === "zsh.exe";
}

/**
 * 为支持注入的 shell 准备一次性临时注入文件：
 * bash 用 --rcfile 替换原 --login -i 参数（--rcfile 与 --login 不兼容，见 BASH_INJECTION 注释）；
 * zsh 通过 env ZDOTDIR 指向临时目录。写入/创建失败时静默降级返回 undefined（终端必须能启动）。
 */
export function prepareShellInjection(
  file: string,
  args: string[],
  env: Record<string, string | undefined>,
): ShellInjection | undefined {
  if (!isInjectedShell(file)) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), "meta-agent-shell-"));
    if (basename(file).toLowerCase().startsWith("bash")) {
      const rcfile = join(dir, "rcfile");
      writeFileSync(rcfile, BASH_INJECTION, "utf8");
      // 去掉原 --login（rcfile 注入不兼容），保留 -i 保证交互；-i 必须放在 --rcfile 之后
      // （bash 对 "-i 后跟 --rcfile" 的参数顺序解析失败，报 "invalid option --"）。
      return { args: ["--rcfile", rcfile, "-i"], env, cleanup: () => removeInjectionDir(dir) };
    }
    writeFileSync(join(dir, ".zshrc"), ZSH_INJECTION, "utf8");
    return { args, env: { ...env, ZDOTDIR: dir }, cleanup: () => removeInjectionDir(dir) };
  } catch {
    return undefined;
  }
}

function removeInjectionDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort 清理，失败忽略
  }
}
