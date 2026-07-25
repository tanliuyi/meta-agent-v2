import type { OAuthLoginCallbacks, OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import type {
  AuthConfigSnapshot,
  AuthOauthLoginEvent,
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
} from "../../shared/auth-config-contracts.ts";

interface PendingRequest {
  resolve(value: string | undefined): void;
  reject(error: Error): void;
}

interface LoginSession {
  ownerId: number;
  abortController: AbortController;
  pending: Map<string, PendingRequest>;
}

interface OauthLoginCoordinatorDependencies {
  login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<AuthConfigSnapshot>;
  createId?(): string;
}

/** Coordinates interactive OAuth callbacks without exposing credentials to the renderer. */
export class OauthLoginCoordinator {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly login: OauthLoginCoordinatorDependencies["login"];
  private readonly createId: () => string;

  constructor(dependencies: OauthLoginCoordinatorDependencies) {
    this.login = dependencies.login;
    this.createId = dependencies.createId ?? crypto.randomUUID;
  }

  async start(
    ownerId: number,
    input: AuthOauthLoginInput,
    emit: (event: AuthOauthLoginEvent) => void,
    openExternal: (url: string) => Promise<void>,
  ): Promise<AuthConfigSnapshot> {
    assertLoginInput(input);
    if (this.sessions.has(input.loginId)) throw new Error("OAuth login is already running");
    const session: LoginSession = {
      ownerId,
      abortController: new AbortController(),
      pending: new Map(),
    };
    this.sessions.set(input.loginId, session);

    const request = (
      event: Omit<Extract<AuthOauthLoginEvent, { type: "request" }>, "loginId" | "requestId">,
    ): Promise<string | undefined> => {
      const requestId = this.createId();
      return new Promise((resolve, reject) => {
        session.pending.set(requestId, { resolve, reject });
        emit({ ...event, loginId: input.loginId, requestId });
      });
    };

    try {
      return await this.login(input.providerId, {
        onAuth: (info) => {
          emit({ loginId: input.loginId, type: "auth", ...info });
          void openExternal(info.url).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            emit({ loginId: input.loginId, type: "progress", message: `无法自动打开浏览器: ${message}` });
          });
        },
        onDeviceCode: (info) => {
          emit({
            loginId: input.loginId,
            type: "device-code",
            verificationUri: info.verificationUri,
            userCode: info.userCode,
            ...(info.expiresInSeconds === undefined ? {} : { expiresInSeconds: info.expiresInSeconds }),
          });
          void openExternal(info.verificationUri).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            emit({ loginId: input.loginId, type: "progress", message: `无法自动打开浏览器: ${message}` });
          });
        },
        onPrompt: async (prompt) => {
          const value = await request({ type: "request", requestType: "prompt", ...prompt });
          if (value === undefined) throw new Error("Login cancelled");
          return value;
        },
        onProgress: (message) => emit({ loginId: input.loginId, type: "progress", message }),
        onSelect: (prompt: OAuthSelectPrompt) =>
          request({
            type: "request",
            requestType: "select",
            message: prompt.message,
            options: prompt.options,
          }),
        onManualCodeInput: () =>
          request({
            type: "request",
            requestType: "manual-code",
            message: "粘贴重定向 URL，或在浏览器中完成登录",
          }).then((value) => {
            if (value === undefined) throw new Error("Login cancelled");
            return value;
          }),
        signal: session.abortController.signal,
      });
    } finally {
      this.finish(input.loginId);
    }
  }

  respond(ownerId: number, response: AuthOauthLoginResponse): void {
    const session = this.sessions.get(response.loginId);
    if (!session || session.ownerId !== ownerId) throw new Error("Unknown OAuth login request");
    const pending = session.pending.get(response.requestId);
    if (!pending) throw new Error("Unknown OAuth prompt request");
    session.pending.delete(response.requestId);
    pending.resolve(response.canceled ? undefined : (response.value ?? ""));
  }

  cancel(ownerId: number, loginId: string): void {
    const session = this.sessions.get(loginId);
    if (!session || session.ownerId !== ownerId) return;
    session.abortController.abort();
    for (const pending of session.pending.values()) pending.reject(new Error("Login cancelled"));
    session.pending.clear();
  }

  cancelOwner(ownerId: number): void {
    for (const [loginId, session] of this.sessions) {
      if (session.ownerId === ownerId) this.cancel(ownerId, loginId);
    }
  }

  private finish(loginId: string): void {
    const session = this.sessions.get(loginId);
    if (!session) return;
    for (const pending of session.pending.values()) pending.resolve(undefined);
    session.pending.clear();
    this.sessions.delete(loginId);
  }
}

function assertLoginInput(input: AuthOauthLoginInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.loginId !== "string" ||
    !input.loginId ||
    typeof input.providerId !== "string" ||
    !input.providerId
  ) {
    throw new TypeError("Invalid OAuth login input");
  }
}
