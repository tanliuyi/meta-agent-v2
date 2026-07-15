import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { HostRequest, HostResponse, SessionSnapshot } from "../../../../shared/contracts.ts";
import { Button } from "../ui/button.tsx";

/** 渲染当前 session 的阻塞式扩展 UI 请求。 */
export function HostRequests({ snapshot }: { snapshot: SessionSnapshot }) {
	const request = snapshot.hostRequests[0];
	const [value, setValue] = useState("");
	useEffect(() => {
		setValue(request?.type === "editor" ? request.message ?? "" : "");
	}, [request?.id, request?.message, request?.type]);
	if (!request) return null;
	if (request.type === "notify") {
		return (
			<div className={`notice notice-${request.notifyType ?? "info"}`}>
				<span>{request.title}</span>
				<Button variant="ghost" size="sm" onClick={() => void respond(snapshot, { requestId: request.id, dismissed: true })}>
					关闭
				</Button>
			</div>
		);
	}
	return (
		<Dialog.Root open>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className="dialog-content host-dialog" onEscapeKeyDown={(event) => event.preventDefault()}>
					<p className="dialog-kicker">{request.toolCallId ? `工具 ${request.toolCallId}` : "Pi 扩展请求"}</p>
					<Dialog.Title className="dialog-title">{request.title}</Dialog.Title>
					{request.message ? <Dialog.Description className="dialog-description">{request.message}</Dialog.Description> : null}
					<RequestField request={request} value={value} onChange={setValue} />
					<div className="dialog-actions">
						<Button variant="ghost" onClick={() => void respond(snapshot, { requestId: request.id, dismissed: true })}>
							取消
						</Button>
						{request.type === "confirm" ? (
							<>
								<Button variant="outline" onClick={() => void respond(snapshot, { requestId: request.id, confirmed: false })}>
									拒绝
								</Button>
								<Button onClick={() => void respond(snapshot, { requestId: request.id, confirmed: true })}>允许</Button>
							</>
						) : (
							<Button disabled={request.type === "select" && !value} onClick={() => void respond(snapshot, { requestId: request.id, value })}>继续</Button>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function RequestField({ request, value, onChange }: { request: HostRequest; value: string; onChange(value: string): void }) {
	if (request.type === "confirm") return null;
	if (request.type === "select") {
		return (
			<div className="host-options">
				{request.options?.map((option) => (
					<button type="button" className={value === option ? "is-active" : ""} key={option} onClick={() => onChange(option)}>
						{option}
					</button>
				))}
			</div>
		);
	}
	return request.type === "editor" ? (
		<textarea className="dialog-editor" rows={10} value={value} onChange={(event) => onChange(event.target.value)} />
	) : (
		<input className="dialog-input" autoFocus value={value} placeholder={request.placeholder} onChange={(event) => onChange(event.target.value)} />
	);
}

async function respond(snapshot: SessionSnapshot, response: HostResponse): Promise<void> {
	await window.desktop.sessions.respond(snapshot.projectId, snapshot.threadId, response);
}
