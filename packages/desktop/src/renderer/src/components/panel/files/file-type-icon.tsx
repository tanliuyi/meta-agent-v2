import { FileIcon } from "react-material-vscode-icons";

export function FileTypeIcon({ name }: { name: string }) {
  return (
    <span className="file-type-icon" aria-hidden="true">
      <FileIcon fileName={name} size={16} />
    </span>
  );
}
