/** Internal, main-to-sidecar resource snapshot. Never accepted from renderer IPC. */
export interface CodexPluginCompanions {
  rootPath: string;
  fingerprint: string;
  skillPaths: string[];
  scripts: string[];
  mcpServers: Record<string, CodexMcpServer>;
}

export type CodexMcpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { type: "http"; url: string; headers: Record<string, string> };
