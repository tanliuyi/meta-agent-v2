// @ts-nocheck -- Vendored upstream module; Desktop boundary behavior is covered by focused tests.
interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}
