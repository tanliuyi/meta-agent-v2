import { ArrowUp, ImagePlus, Octagon, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { ImageInput, SendMode, SessionSnapshot } from "../../../../shared/contracts.ts";
import { Button } from "../ui/button.tsx";
import { ModelSelect, ThinkingSelect } from "./composer-controls.tsx";
import {
	ComposerSuggestions,
	type ComposerSuggestionsHandle,
} from "./composer-suggestions.tsx";

/** 支持图片、steer/follow-up、模型和 thinking 的 session Composer。 */
export function Composer({ snapshot }: { snapshot: SessionSnapshot }) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageInput[]>([]);
	const [mode, setMode] = useState<Exclude<SendMode, "prompt">>("followUp");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const suggestions = useRef<ComposerSuggestionsHandle>(null);
	useEffect(() => {
		if (snapshot.extensionUi.editorText !== undefined) setText(snapshot.extensionUi.editorText);
	}, [snapshot.extensionUi.editorText, snapshot.threadId]);
	const aboveWidgets = snapshot.extensionUi.widgets.filter(({ placement }) => placement === "aboveEditor");
	const belowWidgets = snapshot.extensionUi.widgets.filter(({ placement }) => placement === "belowEditor");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if ((!text.trim() && images.length === 0) || sending) return;
		setSending(true);
		setError(null);
		try {
			await window.desktop.sessions.send({
				projectId: snapshot.projectId,
				threadId: snapshot.threadId,
				text: text.trim(),
				images,
				mode: snapshot.running ? mode : "prompt",
			});
			setText("");
			setImages([]);
		} catch (value) {
			setError(errorMessage(value));
		} finally {
			setSending(false);
		}
	};

	const addImages = async (event: ChangeEvent<HTMLInputElement>) => {
		const files = [...(event.target.files ?? [])];
		try {
			const next = await Promise.all(files.map(readImage));
			setImages((current) => [...current, ...next]);
			setError(null);
		} catch (value) {
			setError(errorMessage(value));
		}
		event.target.value = "";
	};

	const clearQueue = async () => {
		try {
			const queued = await window.desktop.sessions.clearQueue(snapshot.projectId, snapshot.threadId);
			setText((current) => [...queued, current].filter((value) => value.trim()).join("\n\n"));
		} catch (value) {
			setError(errorMessage(value));
		}
	};

	return (
		<div className="composer-wrap">
			{snapshot.queue.steering.length + snapshot.queue.followUp.length > 0 ? (
				<div className="queue-strip">
					<span>{snapshot.queue.steering.length + snapshot.queue.followUp.length} 条消息正在排队</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => void clearQueue()}
					>
						<RotateCcw size={13} /> 清空
					</Button>
				</div>
			) : null}
			<form className="composer" onSubmit={submit}>
				<ComposerSuggestions ref={suggestions} snapshot={snapshot} text={text} onChange={setText} />
				<ComposerWidgets widgets={aboveWidgets} />
				{images.length > 0 ? (
					<div className="attachment-list">
						{images.map((image, index) => (
							<div className="attachment" key={`${image.name}:${index}`}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
								<button type="button" onClick={() => setImages((current) => current.filter((_, item) => item !== index))}>
									<X size={12} />
								</button>
							</div>
						))}
					</div>
				) : null}
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (suggestions.current?.handleKey(event.key)) {
							event.preventDefault();
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={snapshot.running ? "运行中，可发送后续消息" : "向 Pi 发送消息，@ 引用文件，/ 执行命令"}
					rows={2}
				/>
				<div className="composer-toolbar">
					<div className="composer-tools">
						<input ref={fileInput} hidden type="file" accept="image/*" multiple onChange={addImages} />
						<Button variant="ghost" size="icon" aria-label="添加图片" onClick={() => fileInput.current?.click()}>
							<ImagePlus size={16} />
						</Button>
						{snapshot.running ? (
							<div className="mode-control" aria-label="运行中消息模式">
								<button type="button" className={mode === "followUp" ? "is-active" : ""} onClick={() => setMode("followUp")}>
									排队
								</button>
								<button type="button" className={mode === "steer" ? "is-active" : ""} onClick={() => setMode("steer")}>
									引导
								</button>
							</div>
						) : null}
					</div>
					<div className="composer-config">
						<ModelSelect snapshot={snapshot} />
						<ThinkingSelect snapshot={snapshot} />
						{snapshot.running ? (
							<Button
								variant="outline"
								size="icon"
								aria-label="停止运行"
								onClick={() => void window.desktop.sessions.cancel(snapshot.projectId, snapshot.threadId)}
							>
								<Octagon size={14} />
							</Button>
						) : null}
						<Button size="icon" aria-label="发送" type="submit" disabled={sending || snapshot.readiness.state !== "ready"}>
							<ArrowUp size={16} />
						</Button>
					</div>
				</div>
				<ComposerWidgets widgets={belowWidgets} />
			</form>
			{error || snapshot.readiness.state !== "ready" ? (
				<p className="composer-error">{error ?? snapshot.readiness.message}</p>
			) : null}
		</div>
	);
}

function ComposerWidgets({ widgets }: { widgets: SessionSnapshot["extensionUi"]["widgets"] }) {
	if (widgets.length === 0) return null;
	return (
		<div className="composer-widgets">
			{widgets.map((widget) => <pre key={widget.key}>{widget.lines.join("\n")}</pre>)}
		</div>
	);
}

async function readImage(file: File): Promise<ImageInput> {
	if (!file.type.startsWith("image/")) throw new Error(`不支持的附件类型: ${file.type}`);
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(file);
	});
	return { name: file.name, mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
