/**
 * Local Button primitive — a dependency-free native `<button>` wrapper.
 * Approximates the Windhover button variant/size classes; no CVA or base-ui.
 */
import type { ButtonHTMLAttributes, ReactElement } from "react";

function cn(...classes: (string | undefined | false | null)[]): string {
	return classes.filter(Boolean).join(" ");
}

const BASE =
	"inline-flex items-center justify-center gap-1.5 rounded-sm text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover disabled:opacity-50 disabled:pointer-events-none";

const VARIANT: Record<string, string> = {
	default: "bg-primary text-primary-foreground hover:bg-primary/80",
	secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
	destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
	ghost: "hover:bg-muted hover:text-foreground",
};

const SIZE: Record<string, string> = {
	sm: "h-7 px-2.5",
	default: "h-8 px-2.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "default" | "secondary" | "destructive" | "ghost";
	size?: "sm" | "default";
}

export function Button({
	variant = "default",
	size = "default",
	className,
	children,
	...rest
}: ButtonProps): ReactElement {
	return (
		<button
			type="button"
			className={cn(BASE, VARIANT[variant], SIZE[size], className)}
			{...rest}
		>
			{children}
		</button>
	);
}
