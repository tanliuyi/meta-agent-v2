import { AlertCircle, LoaderCircle, RotateCw } from "lucide-react";
import type { SessionSnapshot } from "../../../../shared/contracts.ts";

/** 在 Composer 附近展示当前 session 的权威运行状态。 */
export function SessionStatus({ snapshot }: { snapshot: SessionSnapshot }) {
	const activity = getActivity(snapshot);
	if (!activity && !snapshot.lastError) return null;
	return (
		<div className="session-status" aria-live="polite">
			{activity ? (
				<div className={activity.error ? "session-status-row is-error" : "session-status-row"}>
					{activity.icon}
					<span>{activity.text}</span>
				</div>
			) : null}
			{snapshot.lastError ? (
				<div className="session-status-row is-error" role="alert">
					<AlertCircle size={13} />
					<span>{snapshot.lastError}</span>
				</div>
			) : null}
		</div>
	);
}

function getActivity(snapshot: SessionSnapshot): { text: string; icon: React.ReactNode; error?: boolean } | null {
	if (snapshot.retry) {
		return {
			text: `正在重试 ${snapshot.retry.attempt}/${snapshot.retry.maxAttempts}: ${snapshot.retry.message}`,
			icon: <RotateCw size={13} className="status-spin" />,
		};
	}
	if (snapshot.compacting) {
		return { text: "正在压缩会话上下文", icon: <LoaderCircle size={13} className="status-spin" /> };
	}
	if (snapshot.running && snapshot.extensionUi.workingVisible) {
		return {
			text: snapshot.extensionUi.workingMessage ?? "Pi 正在处理",
			icon: <LoaderCircle size={13} className="status-spin" />,
		};
	}
	return null;
}
