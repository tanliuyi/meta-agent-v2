import DatabaseBackup from "lucide-react/dist/esm/icons/database-backup.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
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

export function MarkdownSyncNotification({ notice }: { notice: PiNoticeMessage }) {
  const details = asRecord(notificationDetails(notice));
  const complete = stringValue(details, "phase") === "complete";
  const filesScanned = numberValue(details, "filesScanned");
  const entriesScanned = numberValue(details, "entriesScanned");
  const imported = numberValue(details, "imported");
  const skipped = numberValue(details, "skipped");
  const removed = numberValue(details, "removed");
  const projectCount = numberValue(details, "projectCount");
  const validResult =
    complete &&
    filesScanned !== undefined &&
    entriesScanned !== undefined &&
    imported !== undefined &&
    skipped !== undefined &&
    removed !== undefined &&
    projectCount !== undefined;

  return (
    <NotificationCard
      notice={notice}
      title={complete ? "Markdown 记忆同步完成" : "正在同步 Markdown 记忆"}
      icon={complete ? <DatabaseBackup /> : <RefreshCw />}
    >
      {validResult ? (
        <>
          <NotificationStats
            items={[
              { label: "扫描文件", value: filesScanned },
              { label: "扫描条目", value: entriesScanned },
              { label: "导入 SQLite", value: imported },
              { label: "重复跳过", value: skipped },
              { label: "清理孤立行", value: removed },
              { label: "项目记忆", value: projectCount },
            ]}
          />
          <NotificationList items={stringList(details, "warnings")} />
        </>
      ) : (
        <p className="builtin-notification-message">
          {complete ? notificationText(notice) : "正在协调 Markdown 文件与 SQLite 搜索镜像。"}
        </p>
      )}
    </NotificationCard>
  );
}
