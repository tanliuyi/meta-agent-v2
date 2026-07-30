import { useSharedClock } from "../../shared/hooks/use-shared-clock.ts";

interface ThreadElapsedTimeProps {
  updatedAt: number;
}

/** 将定时更新限制在时间文本叶子，不重渲染完整 thread row。 */
export function ThreadElapsedTime({ updatedAt }: ThreadElapsedTimeProps) {
  const label = useSharedClock((now) => formatElapsedTime(updatedAt, now));
  return (
    <span className="thread-time" aria-label="更新时间">
      {label}
    </span>
  );
}

function formatElapsedTime(updatedAt: number, now: number): string {
  const diffMinutes = Math.floor((now - updatedAt) / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天`;
  const diffMonths = Math.floor(diffDays / 30);
  return diffMonths < 12 ? `${diffMonths} 个月` : `${Math.floor(diffMonths / 12)} 年`;
}
