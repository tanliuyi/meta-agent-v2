import { Button, type ButtonProps } from "@renderer/shared/ui/button";

export function ThreadListToggle(props: Pick<ButtonProps, "children" | "onClick">) {
  return (
    <Button
      {...props}
      variant="ghost"
      size="sm"
      className="inline-block h-7 p-0 text-left text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground active:text-foreground"
    />
  );
}
