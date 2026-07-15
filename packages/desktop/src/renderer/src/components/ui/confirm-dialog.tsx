import { Dialog } from "radix-ui";
import { Button } from "./button.tsx";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	description: string;
	confirmLabel?: string;
	onOpenChange(open: boolean): void;
	onConfirm(): void;
}

/** shadcn 风格的破坏性操作确认框。 */
export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel = "删除",
	onOpenChange,
	onConfirm,
}: ConfirmDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className="dialog-content">
					<Dialog.Title className="dialog-title">{title}</Dialog.Title>
					<Dialog.Description className="dialog-description">{description}</Dialog.Description>
					<div className="dialog-actions">
						<Dialog.Close asChild>
							<Button variant="ghost">取消</Button>
						</Dialog.Close>
						<Button variant="danger" onClick={onConfirm}>
							{confirmLabel}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
