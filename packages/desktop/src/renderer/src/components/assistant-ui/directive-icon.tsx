import File from "lucide-react/dist/esm/icons/file.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";

interface DirectiveIconProps {
  type: string;
}

export function DirectiveIcon({ type }: DirectiveIconProps) {
  if (type === "file")
    return <File className="aui-directive-chip-icon size-3 shrink-0 self-center" aria-hidden="true" />;
  if (type === "skill")
    return <Sparkles className="aui-directive-chip-icon size-3 shrink-0 self-center" aria-hidden="true" />;

  return null;
}
