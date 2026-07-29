import File from "lucide-react/dist/esm/icons/file.mjs";

interface DirectiveIconProps {
  type: string;
}

export function DirectiveIcon({ type }: DirectiveIconProps) {
  if (type !== "file") return null;

  return <File className="aui-directive-chip-icon size-3 shrink-0 self-center" aria-hidden="true" />;
}
