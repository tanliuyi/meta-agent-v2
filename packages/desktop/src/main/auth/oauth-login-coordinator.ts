import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type {
  AuthConfigSnapshot,
  AuthOauthLoginEvent,
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
} from "../../shared/auth-config-contracts.ts";

interface PendingRequest {
  resolve(value: string | undefined): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface LoginSession {
  ownerId: number;
  abortController: AbortController;
  pending: Map<string, PendingRequest>;
}

interface OauthLoginCoordinatorDependencies {
  login(providerId: string, interaction: AuthInteraction): Promise<AuthConfigSnapshot>;
  createId?(): string;
}

/** Coordinates interactive OAuth callbacks without exposing credentials to the renderer. */
export class OauthLoginCoordinator {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly login: OauthLoginCoordinatorDependencies["login"];
  private readonly createId: () => string;

  constructor(dependencies: OauthLoginCoordinatorDependencies) {
    this.login = dependencies.login;
    this.createId = dependencies.createId ?? (() => crypto.randomUUID());
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
      signal?: AbortSignal,
    ): Promise<string | undefined> => {
      const requestId = this.createId();
      return new Promise((resolve, reject) => {
        const abort = () => {
          session.pending.delete(requestId);
          reject(new Error("Login cancelled"));
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        session.pending.set(requestId, { resolve, reject, cleanup });
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        emit({ ...event, loginId: input.loginId, requestId });
      });
    };

    const prompt = (authPrompt: AuthPrompt): Promise<string> => {
      const response = request(
        {
          type: "request",
          requestType:
            authPrompt.type === "select" ? "select" : authPrompt.type === "manual_code" ? "manual-code" : "prompt",
          message: authPrompt.message,
          ...(authPrompt.type === "select" ? { options: [...authPrompt.options] } : {}),
          ...("placeholder" in authPrompt && authPrompt.placeholder ? { placeholder: authPrompt.placeholder } : {}),
          ...(authPrompt.type !== "select" && "allowEmpty" in authPrompt && authPrompt.allowEmpty
            ? { allowEmpty: true }
            : {}),
        },
        authPrompt.signal,
      );
      return response.then((value) => {
        if (value === undefined) throw new Error("Login cancelled");
        return value;
      });
    };

    try {
      return await this.login(input.providerId, {
        signal: session.abortController.signal,
        prompt,
        notify: (event) => {
          if (event.type === "auth_url") {
            emit({ loginId: input.loginId, type: "auth", url: event.url, instructions: event.instructions });
            void openExternal(event.url).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              emit({ loginId: input.loginId, type: "progress", message: `无法自动打开浏览器: ${message}` });
            });
          } else if (event.type === "device_code") {
            emit({
              loginId: input.loginId,
              type: "device-code",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
            });
            void openExternal(event.verificationUri).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              emit({ loginId: input.loginId, type: "progress", message: `无法自动打开浏览器: ${message}` });
            });
          } else if (event.type === "info") {
            emit({
              loginId: input.loginId,
              type: "info",
              message: event.message,
              ...(event.links ? { links: [...event.links] } : {}),
            });
          } else {
            emit({ loginId: input.loginId, type: "progress", message: event.message });
          }
        },
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
    pending.cleanup();
    pending.resolve(response.canceled ? undefined : (response.value ?? ""));
  }

  cancel(ownerId: number, loginId: string): void {
    const session = this.sessions.get(loginId);
    if (!session || session.ownerId !== ownerId) return;
    session.abortController.abort();
    for (const pending of session.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Login cancelled"));
    }
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
    for (const pending of session.pending.values()) {
      pending.cleanup();
      pending.resolve(undefined);
    }
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
