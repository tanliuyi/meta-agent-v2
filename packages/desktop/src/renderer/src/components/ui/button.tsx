import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva("ui-button", {
	variants: {
		variant: {
			default: "ui-button--default",
			ghost: "ui-button--ghost",
			outline: "ui-button--outline",
			danger: "ui-button--danger",
		},
		size: {
			default: "ui-button--default-size",
			sm: "ui-button--sm",
			icon: "ui-button--icon",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {}

/** shadcn 风格的基础按钮。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant, size, type = "button", ...props },
	ref,
) {
	return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
