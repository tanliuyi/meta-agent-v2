import type { SessionSnapshot } from "../../../../shared/contracts.ts";

/** 当前 session 的模型选择器。 */
export function ModelSelect({ snapshot }: { snapshot: SessionSnapshot }) {
	return (
		<select
			className="config-select model-select"
			value={snapshot.model ? `${snapshot.model.provider}:${snapshot.model.id}` : ""}
			onChange={(event) => {
				const model = snapshot.models.find((item) => `${item.provider}:${item.id}` === event.target.value);
				if (model) {
					void window.desktop.sessions.setModel(
						snapshot.projectId,
						snapshot.threadId,
						model.provider,
						model.id,
					);
				}
			}}
		>
			{snapshot.model ? null : <option value="">选择模型</option>}
			{snapshot.models.map((model) => (
				<option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
					{model.name}
				</option>
			))}
		</select>
	);
}

/** 当前 session 的 thinking level 选择器。 */
export function ThinkingSelect({ snapshot }: { snapshot: SessionSnapshot }) {
	return (
		<select
			className="config-select"
			value={snapshot.thinkingLevel}
			onChange={(event) =>
				void window.desktop.sessions.setThinking(
					snapshot.projectId,
					snapshot.threadId,
					event.target.value as SessionSnapshot["thinkingLevel"],
				)
			}
		>
			{snapshot.thinkingLevels.map((level) => (
				<option key={level} value={level}>
					{level}
				</option>
			))}
		</select>
	);
}
