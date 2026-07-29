import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

interface BashExecutionResult {
  stdout: string;
}

export interface BashRuntimeValidatorOptions {
  execute?: (path: string, args: string[]) => Promise<BashExecutionResult>;
}

export interface BashRuntimeDetails {
  path: string;
  version: string;
}

const BASH_VERSION_PATTERN = /GNU bash, version\s+([^\s(]+)/i;

/** Verify that a selected file is an executable GNU Bash runtime with Git available. */
export async function validateBashRuntime(
  path: string,
  options: BashRuntimeValidatorOptions = {},
): Promise<BashRuntimeDetails> {
  if (!isAbsolute(path)) throw new Error("Bash 路径必须是绝对路径");

  const execute = options.execute ?? executeBash;
  let result: BashExecutionResult;
  try {
    result = await execute(path, ["--version"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法运行所选 Bash: ${message}`);
  }

  const match = BASH_VERSION_PATTERN.exec(result.stdout);
  if (!match?.[1]) throw new Error("所选文件不是可用的 GNU Bash 可执行程序");

  try {
    await execute(path, ["--noprofile", "--norc", "-c", "command -v git >/dev/null"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`所选 Bash 中未找到可用的 Git: ${message}`);
  }

  return { path, version: match[1] };
}

function executeBash(path: string, args: string[]): Promise<BashExecutionResult> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}
