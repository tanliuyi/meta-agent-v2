import { describe, expect, it } from "vitest";
import { officeTransactionAuditErrorCode } from "../src/main/files/office-transaction-audit.ts";

describe("Office transaction audit error normalization", () => {
  it("preserves stable codes and redacts arbitrary error messages", () => {
    expect(officeTransactionAuditErrorCode(Object.assign(new Error("filesystem failure"), { code: "EACCES" }))).toBe(
      "EACCES",
    );
    expect(officeTransactionAuditErrorCode(new Error("STALE_DOCUMENT"))).toBe("STALE_DOCUMENT");
    expect(
      officeTransactionAuditErrorCode(
        new Error("Office 文档替换失败，recovery preimage 保留在 C:\\private\\report.recovery"),
      ),
    ).toBe("COMMIT_FAILED");
  });
});
