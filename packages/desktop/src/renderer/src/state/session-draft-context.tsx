import type { Attachment } from "@assistant-ui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DraftSessionConfig, SessionIdentity } from "../../../shared/contracts.ts";
import { parseSessionRecordKey } from "../runtime/pi-session-store.ts";
import type { DraftPhase } from "./draft-session-context.tsx";
import { useSessionCacheRecords } from "./session-cache-context.tsx";
import { type SessionDraftBinding, SessionDraftHost } from "./session-draft-host.tsx";

/**
 * 单个主 session 持有的 workbench 新会话草稿状态（行为边界，非 React 依赖）。
 * composer 文本/附件、模型配置、提交中标记与 createRequestIds 均按主 session 隔离：
 * 切换主 session 不会串台，A 的草稿不可能在 B 的父会话下提交。
 */
export class SessionDraft {
  readonly key: string;
  readonly parent: SessionIdentity;
  readonly createRequestIds = new Map<string, string>();
  composer = { text: "", attachments: [] as readonly Attachment[] };
  config: DraftSessionConfig | null = null;
  phase: DraftPhase = "loading";
  loadError: string | null = null;
  submitInFlight = false;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(key: string, parent: SessionIdentity) {
    this.key = key;
    this.parent = parent;
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setConfig(config: DraftSessionConfig | null): void {
    if (this.config === config) return;
    this.config = config;
    this.bump();
  }

  setPhase(phase: DraftPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.bump();
  }

  setLoadError(error: string | null): void {
    if (this.loadError === error) return;
    this.loadError = error;
    this.bump();
  }

  setSubmitInFlight(inFlight: boolean): void {
    if (this.submitInFlight === inFlight) return;
    this.submitInFlight = inFlight;
    this.bump();
  }

  setComposer(text: string, attachments: readonly Attachment[]): void {
    if (this.composer.text === text && this.composer.attachments === attachments) return;
    this.composer = { text, attachments };
    this.bump();
  }

  /** 提交成功后的清理：composer 由调用方先 reset（其变更会经订阅同步回本容器）。 */
  clear(): void {
    this.composer = { text: "", attachments: [] };
    this.config = null;
    this.phase = "editing";
    this.loadError = null;
    this.submitInFlight = false;
    this.createRequestIds.clear();
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

interface SessionDraftContextValue {
  bound: ReadonlyMap<string, SessionDraftBinding>;
  register(sessionKey: string): void;
}

const SessionDraftContext = createContext<SessionDraftContextValue | null>(null);

/**
 * 窗口级 workbench 新会话草稿状态：按主 session key 隔离（与 WorkbenchTabProvider 一致）。
 * 每个主 session 持有一个独立的 composer runtime 与配置状态，切换主 session 不共享草稿；
 * 已 retire 的 session 草稿随 cache 记录清理。
 */
export function SessionDraftProvider({ children }: { children: ReactNode }) {
  const records = useSessionCacheRecords();
  const draftsRef = useRef(new Map<string, SessionDraft>());
  const [registered, setRegistered] = useState<readonly string[]>([]);
  const [bound, setBound] = useState<ReadonlyMap<string, SessionDraftBinding>>(new Map());

  const register = useCallback((sessionKey: string) => {
    setRegistered((previous) => {
      if (previous.includes(sessionKey)) return previous;
      if (!draftsRef.current.has(sessionKey)) {
        const identity = parseSessionRecordKey(sessionKey);
        if (!identity) throw new Error(`Invalid workbench draft session key: ${sessionKey}`);
        draftsRef.current.set(sessionKey, new SessionDraft(sessionKey, identity));
      }
      return [...previous, sessionKey];
    });
  }, []);

  const handleBound = useCallback((sessionKey: string, binding: SessionDraftBinding | null) => {
    setBound((previous) => {
      const next = new Map(previous);
      if (binding === null) next.delete(sessionKey);
      else next.set(sessionKey, binding);
      return next;
    });
  }, []);

  // 已 retire 的 session 不再有 workbench 面板，其草稿（含 composer runtime）随 host 卸载清理。
  useEffect(() => {
    const keep = new Set(records.map((record) => record.key));
    setRegistered((previous) => {
      const next = previous.filter((key) => keep.has(key));
      for (const key of previous) {
        if (!keep.has(key)) draftsRef.current.delete(key);
      }
      return next.length === previous.length ? previous : next;
    });
  }, [records]);

  const value = useMemo(() => ({ bound, register }), [bound, register]);

  return (
    <SessionDraftContext.Provider value={value}>
      {registered.map((sessionKey) => {
        const draft = draftsRef.current.get(sessionKey);
        return draft ? <SessionDraftHost key={sessionKey} draft={draft} onReady={handleBound} /> : null;
      })}
      {children}
    </SessionDraftContext.Provider>
  );
}

/** 注册并读取指定主 session 的 workbench 草稿；host 尚未就绪时返回 null。 */
export function useSessionDraft(sessionKey: string): SessionDraftBinding | null {
  const value = useContext(SessionDraftContext);
  if (!value) throw new Error("useSessionDraft must be used inside SessionDraftProvider");
  const binding = value.bound.get(sessionKey) ?? null;
  const draft = binding?.draft ?? null;
  useEffect(() => {
    value.register(sessionKey);
  }, [sessionKey, value.register]);
  const subscribe = useCallback(
    (listener: () => void) => (draft ? draft.subscribe(listener) : () => undefined),
    [draft],
  );
  const getVersion = useCallback(() => draft?.getVersion() ?? 0, [draft]);
  useSyncExternalStore(subscribe, getVersion);
  return binding;
}
