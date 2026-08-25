export type AttachmentFileKind =
  | "archive"
  | "audio"
  | "code"
  | "executable"
  | "generic"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "video"
  | "word";

const SPREADSHEET_EXTENSIONS = new Set(["csv", "ods", "xls", "xlsb", "xlsm", "xlsx"]);
const WORD_EXTENSIONS = new Set(["doc", "docm", "docx", "dot", "dotx", "odt", "rtf"]);
const PRESENTATION_EXTENSIONS = new Set(["key", "odp", "pps", "ppsx", "ppt", "pptm", "pptx"]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip", "zst"]);
const CODE_EXTENSIONS = new Set([
  "c",
  "cpp",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav", "wma"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "webm", "wmv"]);
const EXECUTABLE_EXTENSIONS = new Set(["app", "bat", "cmd", "com", "dmg", "exe", "msi", "pkg"]);

export function getAttachmentFileKind(name: string, contentType?: string): AttachmentFileKind {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = contentType?.toLowerCase() ?? "";
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (
    SPREADSHEET_EXTENSIONS.has(extension) ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  ) {
    return "spreadsheet";
  }
  if (
    WORD_EXTENSIONS.has(extension) ||
    mimeType.includes("wordprocessing") ||
    mimeType === "application/msword" ||
    mimeType === "application/rtf"
  ) {
    return "word";
  }
  if (PRESENTATION_EXTENSIONS.has(extension) || mimeType.includes("presentation") || mimeType.includes("powerpoint")) {
    return "presentation";
  }
  if (
    ARCHIVE_EXTENSIONS.has(extension) ||
    mimeType.includes("archive") ||
    mimeType.includes("compressed") ||
    mimeType.includes("zip")
  ) {
    return "archive";
  }
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (AUDIO_EXTENSIONS.has(extension) || mimeType.startsWith("audio/")) return "audio";
  if (VIDEO_EXTENSIONS.has(extension) || mimeType.startsWith("video/")) return "video";
  if (EXECUTABLE_EXTENSIONS.has(extension)) return "executable";
  return "generic";
}
