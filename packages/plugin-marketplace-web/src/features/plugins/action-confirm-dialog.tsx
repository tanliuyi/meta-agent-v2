import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";

export interface PendingPluginAction {
  title: string;
  description: string;
  destructive?: boolean;
  confirmLabel: string;
  run(): Promise<void>;
}

export function ActionConfirmDialog({
  action,
  onOpenChange,
}: {
  action?: PendingPluginAction;
  onOpenChange(open: boolean): void;
}) {
  return (
    <AlertDialog open={!!action} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{action?.title}</AlertDialogTitle>
          <AlertDialogDescription>{action?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className={
              action?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined
            }
            onClick={() => action?.run()}
          >
            {action?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
