import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus.mjs";

interface EmptyChatStateProps {
  title: string;
  detail: string;
}

/** 渲染未选择 Project 或 session 尚未初始化时的空状态。 */
export function EmptyChatState({ title, detail }: EmptyChatStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <MessageSquarePlus size={22} />
      </div>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
