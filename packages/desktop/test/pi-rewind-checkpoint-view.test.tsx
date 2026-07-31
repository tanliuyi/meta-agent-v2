import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/renderer/src/components/chat/notifications/pi-rewind/checkpoint-diff.tsx";
import { parseCheckpointNotice } from "../src/renderer/src/components/chat/notifications/pi-rewind/checkpoint-notification-data.ts";
import { CheckpointNotificationView } from "../src/renderer/src/components/chat/notifications/pi-rewind/checkpoint-notification-view.tsx";
import type { PiNoticeMessage } from "../src/shared/contracts.ts";

function checkpointNotice(): PiNoticeMessage {
  return {
    id: "checkpoint-1",
    kind: "notice",
    noticeType: "custom",
    title: "pi-rewind.checkpoint",
    content: {
      type: "custom",
      customType: "pi-rewind.checkpoint",
      content: [{ type: "text", text: "fallback" }],
      details: {
        checkpointId: "turn-session-1-1",
        restoreCheckpointId: "resume-session-1",
        reason: "run",
        description: "Update the file",
        fileCount: 1,
        additions: 11,
        deletions: 4,
        truncated: false,
        files: [
          {
            path: "packages/desktop/src/file.ts",
            additions: 11,
            deletions: 4,
          },
        ],
      },
    },
  };
}

describe("CheckpointNotificationView", () => {
  it("renders a Desktop checkpoint summary with collapsed file rows", () => {
    const markup = renderToStaticMarkup(<CheckpointNotificationView notice={checkpointNotice()} />);

    expect(markup).toContain("已编辑 1 个文件");
    expect(markup).toContain("packages/desktop/src/file.ts");
    expect(markup).toContain("+11");
    expect(markup).toContain("-4");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("撤销");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("确认撤销");
    expect(markup).not.toContain("审核");
    expect(markup).not.toContain("diff --git");
  });

  it("renders an expanded file with the shared edit tool diff surface", () => {
    const markup = renderToStaticMarkup(
      <CheckpointNotificationView
        notice={checkpointNotice()}
        initialExpandedPaths={["packages/desktop/src/file.ts"]}
        initialDiffs={{
          "packages/desktop/src/file.ts": {
            patch: [
              "diff --git a/packages/desktop/src/file.ts b/packages/desktop/src/file.ts",
              "--- a/packages/desktop/src/file.ts",
              "+++ b/packages/desktop/src/file.ts",
              "@@ -1 +1 @@",
              "-before",
              "+after",
            ].join("\n"),
            truncated: false,
          },
        }}
      />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('class="tool-diff-hunk"');
    expect(markup).toContain("tool-diff-line-remove");
    expect(markup).toContain("tool-diff-line-add");
    expect(markup).toContain(">before</span>");
    expect(markup).toContain(">after</span>");
    expect(markup).not.toContain("diff --git");
  });

  it("parses unified diff into edit tool line types and current line numbers", () => {
    expect(
      parseUnifiedDiff(["@@ -10,2 +20,3 @@ render", " context", "-before", "+after", "+added"].join("\n")),
    ).toEqual([
      { type: "context", text: "context", lineNumber: "20" },
      { type: "remove", text: "before", lineNumber: "11" },
      { type: "add", text: "after", lineNumber: "21" },
      { type: "add", text: "added", lineNumber: "22" },
    ]);
  });

  it("rejects duplicate or malformed file metadata", () => {
    const notice = checkpointNotice();
    if (notice.content.type !== "custom" || !notice.content.details || typeof notice.content.details !== "object") {
      throw new Error("Invalid fixture");
    }
    notice.content.details = {
      ...notice.content.details,
      files: [
        {
          path: "same.ts",
          additions: 1,
          deletions: 0,
        },
        {
          path: "same.ts",
          additions: 1,
          deletions: 0,
        },
      ],
    };

    expect(parseCheckpointNotice(notice)).toBeUndefined();
  });
});
