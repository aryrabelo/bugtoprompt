import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../../schema";
import { CaptionEditor } from "./CaptionEditor";

// ---------------------------------------------------------------------------
// Ensure DOM is fully reset between tests (vitest does not auto-wire
// @testing-library cleanup unless `globals: true` is set).
afterEach(() => {
	cleanup();
});
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seg1: TranscriptSegment = {
	tStartMs: 0,
	tEndMs: 2000,
	text: "Hello world",
};
const seg2: TranscriptSegment = {
	tStartMs: 2000,
	tEndMs: 4000,
	text: "Foo bar baz",
};

// ---------------------------------------------------------------------------
// Partial vs final distinction
// ---------------------------------------------------------------------------

describe("partial vs final rendering", () => {
	it("renders final segments in distinct elements from the partial", () => {
		render(<CaptionEditor transcript={[seg1]} partial="still speaking..." />);

		const finals = screen.getAllByTestId("transcript-segment");
		const partial = screen.getByTestId("partial-segment");

		expect(finals).toHaveLength(1);
		// Partial element must be a different node to the final element.
		expect(partial).not.toBe(finals[0]);
	});

	it("partial has italic styling; final segments do not", () => {
		render(<CaptionEditor transcript={[seg1, seg2]} partial="typing..." />);

		const partialEl = screen.getByTestId("partial-segment");
		// The partial container carries `italic` via Tailwind class.
		expect(partialEl.className).toContain("italic");

		// Final segments must NOT carry italic.
		for (const node of screen.getAllByTestId("transcript-segment")) {
			expect(node.className).not.toContain("italic");
		}
	});

	it("partial contains the live-dot indicator (pulsing span)", () => {
		render(<CaptionEditor transcript={[]} partial="live words" />);
		const partialEl = screen.getByTestId("partial-segment");
		// The live dot is a span with animate-pulse — confirm it's inside partial.
		const dot = partialEl.querySelector("span[aria-hidden='true']");
		expect(dot).not.toBeNull();
		expect(dot?.className).toContain("animate-pulse");
	});

	it("partial text is displayed inside the partial element", () => {
		render(<CaptionEditor transcript={[]} partial="hello partial" />);
		const partialEl = screen.getByTestId("partial-segment");
		expect(partialEl.textContent).toContain("hello partial");
	});

	it("final segment text is shown but NOT in the partial element", () => {
		render(<CaptionEditor transcript={[seg1]} />);
		expect(screen.getByText("Hello world")).toBeDefined();
		expect(screen.queryByTestId("partial-segment")).toBeNull();
	});

	it("shows 'No transcript yet.' when both transcript and partial are absent", () => {
		render(<CaptionEditor transcript={[]} />);
		expect(screen.getByText("No transcript yet.")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Streaming health badge
// ---------------------------------------------------------------------------

describe("streaming health badge", () => {
	it("renders the live badge when streaming={true}", () => {
		render(<CaptionEditor transcript={[]} streaming={true} />);
		const badge = screen.getByTestId("streaming-live-badge");
		expect(badge).toBeDefined();
		expect(badge.textContent).toContain("live");
	});

	it("does NOT render the degraded badge when streaming={true}", () => {
		render(<CaptionEditor transcript={[]} streaming={true} />);
		expect(screen.queryByTestId("streaming-degraded-badge")).toBeNull();
	});

	it("renders the degraded badge when streaming={false}", () => {
		render(<CaptionEditor transcript={[]} streaming={false} />);
		const badge = screen.getByTestId("streaming-degraded-badge");
		expect(badge).toBeDefined();
		expect(badge.textContent).toContain("rec only");
	});

	it("does NOT render the live badge when streaming={false}", () => {
		render(<CaptionEditor transcript={[]} streaming={false} />);
		expect(screen.queryByTestId("streaming-live-badge")).toBeNull();
	});

	it("renders NO badge when streaming is omitted", () => {
		render(<CaptionEditor transcript={[]} />);
		expect(screen.queryByTestId("streaming-live-badge")).toBeNull();
		expect(screen.queryByTestId("streaming-degraded-badge")).toBeNull();
	});

	it("renders NO badge when streaming is explicitly undefined", () => {
		render(<CaptionEditor transcript={[]} streaming={undefined} />);
		expect(screen.queryByTestId("streaming-live-badge")).toBeNull();
		expect(screen.queryByTestId("streaming-degraded-badge")).toBeNull();
	});

	it("live badge carries a green color class", () => {
		render(<CaptionEditor transcript={[]} streaming={true} />);
		const badge = screen.getByTestId("streaming-live-badge");
		expect(badge.className).toContain("green");
	});

	it("degraded badge carries an amber color class", () => {
		render(<CaptionEditor transcript={[]} streaming={false} />);
		const badge = screen.getByTestId("streaming-degraded-badge");
		expect(badge.className).toContain("amber");
	});
});

// ---------------------------------------------------------------------------
// Editable mode regression guard
// ---------------------------------------------------------------------------

describe("editable mode", () => {
	it("calls onEdit(index, text) when first input changes", () => {
		const onEdit = vi.fn();
		render(
			<CaptionEditor
				transcript={[seg1, seg2]}
				editable={true}
				onEdit={onEdit}
			/>,
		);

		const inputs = screen.getAllByRole("textbox");
		expect(inputs).toHaveLength(2);

		fireEvent.change(inputs[0] as HTMLElement, {
			target: { value: "corrected text" },
		});
		expect(onEdit).toHaveBeenCalledWith(0, "corrected text");
	});

	it("calls onEdit(index, text) with correct index for the second segment", () => {
		const onEdit = vi.fn();
		render(
			<CaptionEditor
				transcript={[seg1, seg2]}
				editable={true}
				onEdit={onEdit}
			/>,
		);

		const inputs = screen.getAllByRole("textbox");
		fireEvent.change(inputs[1] as HTMLElement, {
			target: { value: "fixed second" },
		});
		expect(onEdit).toHaveBeenCalledWith(1, "fixed second");
	});

	it("does not render inputs when editable is false", () => {
		render(<CaptionEditor transcript={[seg1, seg2]} editable={false} />);
		expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	});

	it("does not render inputs when editable is omitted", () => {
		render(<CaptionEditor transcript={[seg1]} />);
		expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Events interleaved into the timeline (review screen)
// ---------------------------------------------------------------------------

describe("events timeline", () => {
	it("interleaves selections and clicks with speech", () => {
		render(
			<CaptionEditor
				transcript={[seg1, seg2]}
				events={[
					{ tMs: 1000, kind: "select", selectedText: "essa parte aqui" },
					{ tMs: 3000, kind: "click", elementName: "Save" },
					{ tMs: 5000, kind: "mark" },
				]}
			/>,
		);
		expect(screen.getAllByTestId("timeline-event")).toHaveLength(3);
		expect(screen.getByText(/essa parte aqui/)).toBeTruthy();
		expect(screen.getByText(/🖱 Save/)).toBeTruthy();
	});

	it("keeps transcript segments editable with the right index when events are present", () => {
		const onEdit = vi.fn();
		render(
			<CaptionEditor
				transcript={[seg1, seg2]}
				events={[{ tMs: 1500, kind: "click", elementName: "Btn" }]}
				editable
				onEdit={onEdit}
			/>,
		);
		fireEvent.change(screen.getByDisplayValue("Hello world"), {
			target: { value: "edited" },
		});
		expect(onEdit).toHaveBeenCalledWith(0, "edited");
	});

	it("shows 'No transcript yet' only with no segments, events, or partial", () => {
		const { rerender } = render(<CaptionEditor transcript={[]} events={[]} />);
		expect(screen.getByText(/No transcript yet/)).toBeTruthy();
		rerender(
			<CaptionEditor transcript={[]} events={[{ tMs: 100, kind: "mark" }]} />,
		);
		expect(screen.queryByText(/No transcript yet/)).toBeNull();
	});
});
