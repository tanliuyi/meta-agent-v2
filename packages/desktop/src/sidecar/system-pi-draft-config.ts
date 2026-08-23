import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type {
  DraftModelOption,
  DraftSessionConfig,
  ModelOption,
  Readiness,
  SlashCommand,
  ThinkingLevel,
} from "../shared/contracts.ts";
import { PiRpcClient } from "./pi-rpc-client.ts";
import { assertSupportedSystemPiVersion, type ProbedSystemPi, resolveAndProbeSystemPi } from "./system-pi-resolver.ts";

export async function loadSystemPiDraftConfig(
  cwd: string,
  agentDir: string,
  resolvePi: (environment: NodeJS.ProcessEnv) => Promise<ProbedSystemPi> = resolveAndProbeSystemPi,
): Promise<DraftSessionConfig> {
  const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const pi = await resolvePi(environment);
  assertSupportedSystemPiVersion(pi.version);
  const { client, handshake } = await PiRpcClient.launch({
    pi,
    cwd,
    environment,
    piArgs: ["--no-session"],
  });
  try {
    const models = parseModels(handshake.models);
    const active = parseModel(handshake.state.model);
    const selected =
      (active && models.find((model) => model.provider === active.provider && model.id === active.id)) ?? models[0];
    const thinkingLevels = selected?.thinkingLevels ?? ["off"];
    const thinkingLevel = parseThinkingLevel(handshake.state.thinkingLevel, thinkingLevels);
    return {
      models,
      commands: parseCommands(handshake.commands),
      model: selected ? { provider: selected.provider, id: selected.id, name: selected.name } : null,
      thinkingLevel,
      thinkingLevels: selected?.thinking ? thinkingLevels : ["off"],
      readiness: readiness(selected, models.length),
    };
  } finally {
    await client.close();
  }
}

function parseModels(values: readonly unknown[]): DraftModelOption[] {
  return values.flatMap((value) => {
    const model = parseModel(value);
    if (!model) return [];
    return [
      {
        ...model,
        thinkingLevels: parseThinkingLevels(getSupportedThinkingLevels(value as Model<Api>)),
      },
    ];
  });
}

function parseModel(value: unknown): ModelOption | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.provider !== "string" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.contextWindow !== "number"
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    id: value.id,
    name: value.name,
    contextWindow: value.contextWindow,
    thinking: value.reasoning === true,
  };
}

function parseCommands(values: readonly unknown[]): SlashCommand[] {
  return values.flatMap((value) => {
    if (!isRecord(value) || typeof value.name !== "string") return [];
    if (value.source !== "extension" && value.source !== "prompt" && value.source !== "skill") return [];
    return [
      {
        name: value.name,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        source: value.source,
      },
    ];
  });
}

function parseThinkingLevels(values: readonly unknown[]): ThinkingLevel[] {
  const levels = values.flatMap((value) => (isThinkingLevel(value) ? [value] : []));
  return levels.length > 0 ? levels : ["off"];
}

function parseThinkingLevel(value: unknown, available: readonly ThinkingLevel[]): ThinkingLevel {
  return isThinkingLevel(value) && available.includes(value) ? value : (available[0] ?? "off");
}

function readiness(model: DraftModelOption | undefined, availableCount: number): Readiness {
  if (model) return { state: "ready" };
  if (availableCount === 0)
    return { state: "missing-credentials", message: "System Pi has no available authenticated models" };
  return { state: "unavailable-model", message: "System Pi has no active model" };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
