/**
 * Target binding fallback: when the overlay can't infer the current target
 * from the app (nothing open, or a standalone host), the user picks one.
 * Backed by `client.listTargets` via the BugToPromptClient.
 *
 * Renders a filterable combobox: typing narrows by name OR branch; keyboard
 * navigation (ArrowUp/Down, Enter, Escape); clear empty/no-results states;
 * selected item shows a check mark and can be clicked again to deselect.
 */

import { Check, ChevronDown, X } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { BugToPromptClient, Target } from "../../client";

function cn(...classes: (string | undefined | false | null)[]): string {
	return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Pure helper — exported so unit tests can exercise it without rendering.
// ---------------------------------------------------------------------------

/**
 * Returns the subset of `options` whose `name` OR `branch` contains `query` as
 * a case-insensitive substring. An empty (or whitespace-only) query returns
 * the full list unchanged.
 */
export function filterTargets(options: Target[], query: string): Target[] {
	const q = query.trim().toLowerCase();
	if (!q) return options;
	return options.filter(
		(o) =>
			o.name.toLowerCase().includes(q) || o.branch.toLowerCase().includes(q),
	);
}

// ---------------------------------------------------------------------------
// Hook: data fetching
// ---------------------------------------------------------------------------

function useTargetOptions(
	client: BugToPromptClient,
	projectId: string | undefined,
): { options: Target[]; loading: boolean; failed: boolean } {
	const [options, setOptions] = useState<Target[]>([]);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!projectId) {
			setOptions([]);
			setFailed(false);
			return;
		}
		let alive = true;
		setLoading(true);
		setFailed(false);
		client
			.listTargets(projectId)
			.then((o) => {
				if (alive) {
					setOptions(o);
					setLoading(false);
				}
			})
			.catch(() => {
				if (alive) {
					setFailed(true);
					setLoading(false);
				}
			});
		return () => {
			alive = false;
		};
	}, [client, projectId]);

	return { options, loading, failed };
}

// ---------------------------------------------------------------------------
// Hook: keyboard navigation
// ---------------------------------------------------------------------------

function useKeyboardNav({
	open,
	filtered,
	highlighted,
	value,
	openList,
	closeList,
	pick,
	clearSelection,
	setHighlighted,
	setQuery,
}: {
	open: boolean;
	filtered: Target[];
	highlighted: number;
	value: string | undefined;
	openList: () => void;
	closeList: () => void;
	pick: (opt: Target) => void;
	clearSelection: () => void;
	setHighlighted: React.Dispatch<React.SetStateAction<number>>;
	setQuery: React.Dispatch<React.SetStateAction<string>>;
}): (e: React.KeyboardEvent<HTMLInputElement>) => void {
	const actions: Record<
		string,
		(e: React.KeyboardEvent<HTMLInputElement>) => void
	> = {
		ArrowDown: (e) => {
			e.preventDefault();
			if (!open) {
				openList();
			} else {
				setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
			}
		},
		ArrowUp: (e) => {
			e.preventDefault();
			setHighlighted((h) => Math.max(h - 1, 0));
		},
		Enter: (e) => {
			e.preventDefault();
			if (open && filtered.length > 0) {
				pick(filtered[highlighted]);
			} else if (!open) {
				openList();
			}
		},
		Escape: (e) => {
			e.preventDefault();
			// A selected value takes priority: Escape clears the selection so
			// keyboard users have a mouse-free path to onChange(undefined).
			if (value) {
				clearSelection();
			}
			setQuery("");
			closeList();
		},
		Backspace: (e) => {
			// When the query is empty and a value is selected, Backspace clears
			// the selection. Otherwise fall through to native text editing.
			if (!(e.currentTarget.value === "" && value)) return;
			e.preventDefault();
			clearSelection();
		},
	};

	return (e: React.KeyboardEvent<HTMLInputElement>) => {
		actions[e.key]?.(e);
	};
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TargetPicker({
	client,
	projectId,
	value,
	onChange,
}: {
	client: BugToPromptClient;
	projectId?: string;
	value?: string;
	onChange: (workspaceId: string | undefined, branch?: string) => void;
}): ReactElement | null {
	const { options, loading, failed } = useTargetOptions(client, projectId);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [highlighted, setHighlighted] = useState(0);

	const inputRef = useRef<HTMLInputElement>(null);
	const baseId = useId();
	const listboxId = `${baseId}-listbox`;

	const filtered = filterTargets(options, query);
	const selected = options.find((o) => o.id === value);

	const openList = () => {
		setOpen(true);
		setHighlighted(0);
	};

	const closeList = () => {
		setOpen(false);
	};

	const pick = (opt: Target) => {
		if (opt.id === value) {
			// Click on the already-selected option → clear
			onChange(undefined, undefined);
		} else {
			onChange(opt.id, opt.branch);
		}
		setQuery("");
		closeList();
	};

	const clearSelection = () => {
		onChange(undefined, undefined);
		setQuery("");
		inputRef.current?.focus();
	};

	const handleKeyDown = useKeyboardNav({
		open,
		filtered,
		highlighted,
		value,
		openList,
		closeList,
		pick,
		clearSelection,
		setHighlighted,
		setQuery,
	});

	// Nothing to pick and no error/loading → render nothing rather than an empty
	// "No targets" select (e.g. a host with no target list configured).
	if (!loading && !failed && options.length === 0) return null;

	return (
		<div className="relative w-full">
			{/* Trigger / input row */}
			<div
				className={cn(
					"flex h-8 w-full items-center rounded-sm border bg-transparent text-xs",
					open ? "border-ring" : "border-input",
				)}
			>
				<input
					ref={inputRef}
					role="combobox"
					aria-expanded={open}
					aria-haspopup="listbox"
					aria-autocomplete="list"
					aria-controls={open ? listboxId : undefined}
					aria-activedescendant={
						open && filtered.length > 0
							? `${baseId}-opt-${highlighted}`
							: undefined
					}
					className="flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground"
					placeholder={selected ? selected.name : "Select a target…"}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						if (!open) openList();
						setHighlighted(0);
					}}
					onFocus={openList}
					onBlur={() => {
						// Defer so mousedown on a list item fires first.
						setTimeout(closeList, 120);
					}}
					onKeyDown={handleKeyDown}
				/>
				{value && (
					<button
						type="button"
						tabIndex={0}
						aria-label="Clear selection"
						className="px-1 text-muted-foreground hover:text-foreground"
						onMouseDown={(e) => {
							// Prevent the input blur → list-close from firing first;
							// the actual clear runs in onClick (fires for mouse + keyboard).
							e.preventDefault();
						}}
						onClick={clearSelection}
					>
						<X className="size-3" />
					</button>
				)}
				<ChevronDown
					className={cn(
						"mr-1.5 size-3 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
				/>
			</div>

			{/* Dropdown list */}
			{open && (
				<div
					role="listbox"
					id={listboxId}
					className="absolute z-50 mt-px max-h-48 w-full overflow-y-auto rounded-sm border border-input bg-popover py-1 shadow-md"
				>
					{loading ? (
						<div className="px-2 py-1.5 text-xs text-muted-foreground">
							Loading…
						</div>
					) : failed ? (
						<div className="px-2 py-1.5 text-xs text-destructive">
							Couldn&apos;t load targets
						</div>
					) : options.length === 0 ? (
						<div className="px-2 py-1.5 text-xs text-muted-foreground">
							No targets
						</div>
					) : filtered.length === 0 ? (
						<div className="px-2 py-1.5 text-xs text-muted-foreground">
							No matches for &ldquo;{query}&rdquo;
						</div>
					) : (
						filtered.map((opt, i) => {
							const isSelected = opt.id === value;
							const isHighlighted = i === highlighted;
							return (
								<div
									key={opt.id}
									role="option"
									id={`${baseId}-opt-${i}`}
									aria-selected={isSelected}
									// tabIndex={-1} keeps item reachable for a11y tooling without
									// stealing keyboard focus from the input.
									tabIndex={-1}
									className={cn(
										"flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 text-xs",
										isHighlighted
											? "bg-accent text-accent-foreground"
											: "text-popover-foreground",
										isSelected && "font-medium",
									)}
									onMouseEnter={() => setHighlighted(i)}
									onMouseDown={(e) => {
										// Keep input focused so blur doesn't fire before click.
										e.preventDefault();
										pick(opt);
									}}
								>
									<Check
										className={cn(
											"size-3 shrink-0",
											isSelected ? "opacity-100" : "opacity-0",
										)}
									/>
									<span className="flex-1 truncate">{opt.name}</span>
									<span className="text-muted-foreground">{opt.branch}</span>
								</div>
							);
						})
					)}
				</div>
			)}
		</div>
	);
}
