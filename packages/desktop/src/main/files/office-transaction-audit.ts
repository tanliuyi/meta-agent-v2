export function officeTransactionAuditErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code;
  }
  if (error instanceof Error) {
    if (error.message === "STALE_DOCUMENT") return "STALE_DOCUMENT";
    if (error.message.endsWith("修改计划校验失败") || error.message === "Office 文档计划校验失败") {
      return "PLAN_HASH_MISMATCH";
    }
    if (error.message.endsWith("文档正在保存")) return "COMMIT_IN_PROGRESS";
    if (error.message.endsWith("文档缓存容量不足")) return "CACHE_CAPACITY_EXCEEDED";
  }
  return "COMMIT_FAILED";
}
