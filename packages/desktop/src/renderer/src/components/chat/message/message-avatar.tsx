import defaultAssistantAvatar from "@renderer/assets/providers/default-assistant.svg";
import { providerIcon } from "@renderer/shared/lib/provider-icons";

/** 对话消息旁的模型提供方头像：优先品牌图标，缺失时使用统一的 assistant 默认头像。 */
export function MessageAvatar({ provider }: { provider: string }) {
  const icon = providerIcon(provider);
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
