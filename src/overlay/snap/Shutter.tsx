/**
 * Capture-frame shutter — portals a full-viewport overlay to document.body that
 * flashes a thin "viewfinder" frame at the screen edges (~160ms) then unmounts;
 * fires once per `trigger` increment.
 *
 * This deliberately is NOT a glassmorphism veil: a double-stroke inset ring (a
 * tinted near-white core + a tinted near-dark halo) reads as "this frame was
 * captured" and stays visible on light OR dark host themes, with no backdrop
 * blur (so no full-viewport repaint cost). Motion is ease-out-expo (no bounce)
 * and is neutralized under prefers-reduced-motion.
 *
 * ORDERING CONTRACT: trigger is bumped by useSession.mark() strictly AFTER
 * grabber.grab() resolves, so the frame never composites on top of a live grab.
 *
 * Host-agnostic: manages its own keyframe injection, no Tailwind dependency.
 */
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const STYLE_ID = "snap-shutter-styles";

/**
 * The shutter frame + the mark-counter pulse (referenced by BugToPrompt via the
 * `snap-count-pulse` class). Kept as injected CSS so the reduced-motion media
 * query can override them — an inline `style` animation cannot be.
 */
const STYLES = `
@keyframes snap-shutter-frame {
  0%   { opacity: 0; }
  18%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes snap-count-pulse {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.18); }
  100% { transform: scale(1); }
}
.snap-shutter-frame {
  position: fixed;
  inset: 0;
  z-index: 99998;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 2px rgba(252, 250, 245, 0.95),
    inset 0 0 0 5px rgba(20, 22, 32, 0.5);
  animation: snap-shutter-frame 160ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.snap-count-pulse {
  transform-origin: right center;
  animation: snap-count-pulse 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
@media (prefers-reduced-motion: reduce) {
  .snap-shutter-frame {
    animation-duration: 1ms;
    box-shadow: inset 0 0 0 2px rgba(252, 250, 245, 0.95);
  }
  .snap-count-pulse { animation: none; }
}
`;

function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

export interface ShutterProps {
	/**
	 * Incremented by useSession each time a snap fires (after grab resolves).
	 * Component animates once per increment; ignored when 0.
	 */
	trigger: number;
}

export function Shutter({ trigger }: ShutterProps): ReactElement | null {
	const [visible, setVisible] = useState(false);

	// Inject styles once on mount so BugToPrompt can reference snap-count-pulse.
	useEffect(() => {
		ensureStyles();
	}, []);

	useEffect(() => {
		if (trigger === 0) return;
		setVisible(true);
		// Slightly longer than the 160ms animation so the fade fully completes.
		const id = setTimeout(() => setVisible(false), 180);
		return () => clearTimeout(id);
	}, [trigger]);

	if (!visible || typeof document === "undefined") return null;

	return createPortal(
		<div className="snap-shutter-frame" aria-hidden="true" />,
		document.body,
	);
}
