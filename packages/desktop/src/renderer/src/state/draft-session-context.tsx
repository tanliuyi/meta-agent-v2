import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DraftSessionConfig, SessionIdentity } from "../../../shared/contracts.ts";
import { imageAttachmentAdapter } from "../runtime/image-attachments.ts";

const EMPTY_MESSAGES: readonly ThreadMessage[] = [];

export type DraftPhase = "loading" | "editing" | "materializing" | "no-project";

interface MutableValue<T> {
  current: T;
}

interface DraftSessionContextValue {
  runtime: AssistantRuntime;
  projectId: string | null;
  setProjectId: Dispatch<SetStateAction<string | null>>;
  config: DraftSessionConfig | null;
  setConfig: Dispatch<SetStateAction<DraftSessionConfig | null>>;
  configProjectId: string | null;
  setConfigProjectId: Dispatch<SetStateAction<string | null>>;
  phase: DraftPhase;
  setPhase: Dispatch<SetStateAction<DraftPhase>>;
  loadError: string | null;
  setLoadError: Dispatch<SetStateAction<string | null>>;
  navigationTarget: SessionIdentity | null;
  setNavigationTarget: Dispatch<SetStateAction<SessionIdentity | null>>;
  submitInFlight: MutableValue<boolean>;
  createRequestIds: Map<string, string>;
  projectFallbackAllowed: MutableValue<boolean>;
  clear(nextProjectId: string | null, navigationTarget: SessionIdentity): Promise<void>;
}

const DraftSessionContext = createContext<DraftSessionContextValue | null>(null);

/** Owns the window-scoped draft runtime and configuration across route unmounts. */
export function DraftSessionProvider({ children }: { children: ReactNode }) {
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messages: EMPTY_MESSAGES,
      isSendDisabled: true,
      onNew: rejectUnexpectedDraftSend,
      adapters: { attachments: imageAttachmentAdapter },
      unstable_enableToolInvocations: false,
    }),
    [],
  );
  const runtime = useExternalStoreRuntime(adapter);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [config, setConfig] = useState<DraftSessionConfig | null>(null);
  const [configProjectId, setConfigProjectId] = useState<string | null>(null);
  const [phase, setPhase] = useState<DraftPhase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<SessionIdentity | null>(null);
  const submitInFlight = useRef(false);
  const createRequestIds = useRef(new Map<string, string>()).current;
  const projectFallbackAllowed = useRef(true);

  const clear = useCallback(
    async (nextProjectId: string | null, target: SessionIdentity) => {
      await runtime.thread.composer.reset();
      createRequestIds.clear();
      projectFallbackAllowed.current = true;
      setProjectId(nextProjectId);
      setConfig(null);
      setConfigProjectId(null);
      setPhase(nextProjectId ? "editing" : "no-project");
      setLoadError(null);
      setNavigationTarget(target);
    },
    [createRequestIds, runtime],
  );

  const value = useMemo<DraftSessionContextValue>(
    () => ({
      runtime,
      projectId,
      setProjectId,
      config,
      setConfig,
      configProjectId,
      setConfigProjectId,
      phase,
      setPhase,
      loadError,
      setLoadError,
      navigationTarget,
      setNavigationTarget,
      submitInFlight,
      createRequestIds,
      projectFallbackAllowed,
      clear,
    }),
    [clear, config, configProjectId, createRequestIds, loadError, navigationTarget, phase, projectId, runtime],
  );

  return <DraftSessionContext.Provider value={value}>{children}</DraftSessionContext.Provider>;
}

export function useDraftSession(): DraftSessionContextValue {
  const value = useContext(DraftSessionContext);
  if (!value) throw new Error("useDraftSession must be used inside DraftSessionProvider");
  return value;
}

async function rejectUnexpectedDraftSend(): Promise<void> {
  throw new Error("Draft submission must be handled before creating a Pi session");
}
