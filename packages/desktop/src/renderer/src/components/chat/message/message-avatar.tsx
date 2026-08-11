import defaultAssistantAvatar from "@renderer/assets/providers/default-assistant.svg";
import { getModelIconSource } from "@renderer/components/assistant-ui/model-selector/model-selector-icons";
import { providerIcon } from "@renderer/shared/lib/provider-icons";

/** 对话消息旁的模型头像：优先模型品牌图标，其次 provider 图标，缺失时使用统一的 assistant 默认头像。 */
export function MessageAvatar({ provider, model }: { provider: string; model: string }) {
  const icon = getModelIconSource(provider, model, model) ?? providerIcon(provider);
  return (
    <span className={icon ? "message-avatar" : "message-avatar message-avatar-assistant-default"} aria-hidden="true">
      <img
        src={icon ?? defaultAssistantAvatar}
        alt=""
        draggable={false}
        className={icon ? undefined : "message-avatar-assistant-image"}
      />
    </span>
  );
}
