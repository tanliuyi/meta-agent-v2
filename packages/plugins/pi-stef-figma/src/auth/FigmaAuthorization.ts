import fs from 'fs';
import * as os from 'os';
import path from 'path';
import z from 'zod';

/** ~/.pi/sf/figma/config.json (fork-inlined @pi-stef/paths) */
export function getFigmaConfigPath(home?: string): string {
  return path.join(home ?? currentHomeDir(), '.pi', 'sf', 'figma', 'config.json');
}

const McpConfigSchema = z.object({
  mcpServers: z.object({
    Framelink_Figma_MCP: z.object({
      args: z.array(z.string()),
    }),
  }),
});

export const FigmaConfigSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .refine((config) => Boolean(config.apiToken ?? config.apiKey), {
    message: 'Expected apiToken or legacy apiKey',
  })
  .transform((config) => {
    const apiToken = config.apiToken ?? config.apiKey;
    if (!apiToken) {
      throw new Error('Expected apiToken or legacy apiKey');
    }
    return {
      apiToken,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    };
  });
export type FigmaConfig = z.infer<typeof FigmaConfigSchema>;

function currentHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export const FIGMA_CONFIG_PATH = getFigmaConfigPath();

export interface FigmaAuthorizationOptions {
  /** Token from host configuration (e.g. Desktop pi.getConfig()), takes priority over file/env sources. */
  apiToken?: string;
}

function toConfig(raw: unknown): FigmaConfig | null {
  const parsed = FigmaConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export class FigmaAuthorization {
  private config: FigmaConfig | null = null;

  constructor(private readonly options: FigmaAuthorizationOptions = {}) {}

  getConfig(): FigmaConfig {
    return this.parseConfig();
  }

  private readFromEnv(): FigmaConfig | null {
    const apiToken =
      process.env.FIGMA_API_TOKEN ??
      process.env.FIGMA_TOKEN ??
      process.env.FIGMA_ACCESS_TOKEN;
    if (!apiToken) return null;
    return { apiToken };
  }

  private readConfigFile(configPath: string): FigmaConfig | null {
    if (!fs.existsSync(configPath)) return null;

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return toConfig(JSON.parse(content) as unknown);
    } catch {
      console.debug(
        `Failed to read Figma credentials file at ${configPath}, falling back.`,
      );
    }
    return null;
  }

  private getMcpConfigPath(): string | null {
    let currentDir = process.cwd();
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const configPath = path.join(currentDir, '.mcp.json');
      if (fs.existsSync(configPath)) {
        return configPath;
      }
      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  private parseApiKeyFromArgs(args: string[]): string | null {
    for (const arg of args) {
      if (arg.startsWith('--figma-api-key=')) {
        return arg.replace('--figma-api-key=', '');
      }
    }
    return null;
  }

  private readFromMcpConfig(): FigmaConfig | null {
    const configPath = this.getMcpConfigPath();
    if (!configPath) return null;

    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const rawConfig = JSON.parse(configContent) as unknown;

      const mcpConfig = McpConfigSchema.safeParse(rawConfig);
      if (!mcpConfig.success) return null;

      const apiKey = this.parseApiKeyFromArgs(
        mcpConfig.data.mcpServers.Framelink_Figma_MCP.args,
      );
      if (!apiKey) return null;

      return { apiToken: apiKey, apiKey };
    } catch {
      return null;
    }
  }

  private readConfig(): FigmaConfig {
    // Primary: host configuration (Desktop extension config).
    if (this.options.apiToken) {
      return { apiToken: this.options.apiToken };
    }

    // Fallback: canonical Pi user config.
    const fromCanonicalFile = this.readConfigFile(getFigmaConfigPath());
    if (fromCanonicalFile) return fromCanonicalFile;

    // Compatibility: environment variables for existing scripts/tests.
    const fromEnv = this.readFromEnv();
    if (fromEnv) return fromEnv;

    // Fallback: .mcp.json
    const fromMcp = this.readFromMcpConfig();
    if (fromMcp) return fromMcp;

    throw new Error(
      'Figma API token not found. Configure it in the extension settings (apiToken) or create ~/.pi/sf/figma/config.json with { "apiToken": "..." }, or set FIGMA_API_TOKEN.',
    );
  }

  private parseConfig(): FigmaConfig {
    if (this.config) {
      return this.config;
    }

    const config = this.readConfig();
    this.config = config;
    return config;
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const config = this.getConfig();
    const headers = new Headers(init?.headers);
    headers.set('X-Figma-Token', config.apiToken);

    return fetch(url, {
      ...init,
      headers,
    });
  }
}
