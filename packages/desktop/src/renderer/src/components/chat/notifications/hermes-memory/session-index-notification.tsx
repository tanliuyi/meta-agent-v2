import Database from "lucide-react/dist/esm/icons/database.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import {
  asRecord,
  notificationDetails,
  notificationText,
  numberValue,
  stringList,
  stringValue,
} from "../notification-data.ts";
import { NotificationList } from "../notification-list.tsx";
import { NotificationStats } from "../notification-stats.tsx";

export function SessionIndexNotification({ notice }: { notice: PiNoticeMessage }) {
  const details = asRecord(notificationDetails(notice));
  const phase = stringValue(details, "phase");
  const totalFiles = numberValue(details, "totalFiles");
  const projectCount = numberValue(details, "projectCount");
  const sessionsProcessed = numberValue(details, "sessionsProcessed");
  const sessionsIndexed = numberValue(details, "sessionsIndexed");
  const sessionsSkipped = numberValue(details, "sessionsSkipped");
  const messagesIndexed = numberValue(details, "messagesIndexed");
  const complete = phase === "complete";
  const validProgress = phase === "indexing" && totalFiles !== undefined && projectCount !== undefined;
  const validResult =
    complete &&
    sessionsProcessed !== undefined &&
    sessionsIndexed !== undefined &&
    sessionsSkipped !== undefined &&
    messagesIndexed !== undefined;

  return (
    <NotificationCard
      notice={notice}
      title={complete ? "会话索引完成" : phase === "scan" ? "正在扫描会话目录" : "正在索引历史会话"}
      icon={complete ? <Database /> : <LoaderCircle />}
    >
      {validProgress ? (
        <NotificationStats
          items={[
            { label: "会话文件", value: totalFiles },
            { label: "项目", value: projectCount },
          ]}
        />
      ) : validResult ? (
        <>
          <NotificationStats
            items={[
              { label: "处理会话", value: sessionsProcessed },
              { label: "新增索引", value: sessionsIndexed },
              { label: "已跳过", value: sessionsSkipped },
              { label: "索引消息", value: messagesIndexed },
            ]}
          />
          <NotificationList items={stringList(details, "projects")} />
          <NotificationList items={stringList(details, "errors")} />
        </>
      ) : (
        <p className="builtin-notification-message">
          {phase === "scan" ? "正在统计可索引的历史会话。" : notificationText(notice)}
        </p>
      )}
    </NotificationCard>
  );
}
