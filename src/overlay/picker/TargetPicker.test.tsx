import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient, Target } from "../../client";
import { filterTargets, TargetPicker } from "./TargetPicker";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGETS: Target[] = [
	{ id: "1", name: "Frontend App", branch: "main" },
	{ id: "2", name: "Backend API", branch: "feat/api-v2" },
	{ id: "3", name: "Admin Panel", branch: "hotfix/login" },
];

function makeClient(targets: Target[] = TARGETS): BugToPromptClient {
	return {
		mintStreamingToken: vi.fn().mockResolvedValue({ token: "t", expiresAt: 0 }),
		saveArtifact: vi.fn().mockResolvedValue({ dir: "/tmp", sessionId: "s1" }),
		transcribeBatch: vi.fn().mockResolvedValue({ transcript: [] }),
		createIssue: vi
			.fn()
			.mockResolvedValue({ created: true, number: 1, url: "https://gh" }),
		listTargets: vi.fn().mockResolvedValue(targets),
	};
}

// ---------------------------------------------------------------------------
// filterTargets — pure unit tests (no rendering)
// ---------------------------------------------------------------------------

describe("filterTargets", () => {
	it("returns all options when query is empty", () => {
		expect(filterTargets(TARGETS, "")).toEqual(TARGETS);
	});

	it("returns all options when query is whitespace only", () => {
		expect(filterTargets(TARGETS, "   ")).toEqual(TARGETS);
	});

	it("filters by name case-insensitively", () => {
		const result = filterTargets(TARGETS, "FRONTEND");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("1");
	});

	it("filters by branch case-insensitively", () => {
		const result = filterTargets(TARGETS, "feat");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("2");
	});

	it("filters by partial name substring", () => {
		// "API" appears only in "Backend API"
		const result = filterTargets(TARGETS, "api");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("2");
	});

	it("matches partial branch substring", () => {
		// "hot" only in "hotfix/login" (Admin Panel)
		const result = filterTargets(TARGETS, "hot");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("3");
	});

	it("returns all options when query matches every item", () => {
		// "a" appears in every entry's name or branch
		const result = filterTargets(TARGETS, "a");
		expect(result).toHaveLength(3);
	});

	it("returns empty array when nothing matches", () => {
		expect(filterTargets(TARGETS, "zzz-no-match")).toEqual([]);
	});

	it("handles an empty options array gracefully", () => {
		expect(filterTargets([], "anything")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// TargetPicker — render / interaction tests
// ---------------------------------------------------------------------------

describe("TargetPicker", () => {
	it("renders a combobox input", () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);
		// getByRole throws if not found — that is the assertion.
		screen.getByRole("combobox");
	});

	it("calls listTargets with the given projectId on mount", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);
		await waitFor(() => expect(client.listTargets).toHaveBeenCalledWith("p1"));
	});

	it("does not call listTargets when projectId is undefined", () => {
		const client = makeClient();
		render(<TargetPicker client={client} onChange={vi.fn()} />);
		expect(client.listTargets).not.toHaveBeenCalled();
	});

	it("opens the dropdown on focus and shows loaded options", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		fireEvent.focus(screen.getByRole("combobox"));

		await waitFor(() => {
			expect(screen.getAllByRole("option")).toHaveLength(3);
		});

		// getByText throws if absent — confirms presence of each option
		screen.getByText("Frontend App");
		screen.getByText("Backend API");
		screen.getByText("Admin Panel");
	});

	it("renders nothing when there are no targets", async () => {
		const client = makeClient([]);
		const { container } = render(
			<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />,
		);

		// Starts in a loading state (a combobox), then collapses to null once the
		// empty target list resolves — no meaningless "No targets" select.
		await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
		expect(container.firstChild).toBeNull();
	});

	it("shows a distinct failure state (not 'No targets') when listTargets rejects", async () => {
		const client = makeClient();
		vi.mocked(client.listTargets).mockRejectedValue(new Error("network"));
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		fireEvent.focus(screen.getByRole("combobox"));

		await waitFor(() =>
			expect(screen.queryByText("Couldn't load targets")).not.toBeNull(),
		);
		// A fetch failure must NOT be conflated with a legitimately empty result.
		expect(screen.queryByText("No targets")).toBeNull();
	});

	it("narrows the list when the user types a matching query", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);

		// Wait for all 3 options to load
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		// Type a filter that only matches "Frontend App" (by name)
		fireEvent.change(input, { target: { value: "front" } });

		expect(screen.getAllByRole("option")).toHaveLength(1);
		screen.getByText("Frontend App");
		expect(screen.queryByText("Backend API")).toBeNull();
		expect(screen.queryByText("Admin Panel")).toBeNull();
	});

	it("narrows by branch substring", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.change(input, { target: { value: "feat" } });

		expect(screen.getAllByRole("option")).toHaveLength(1);
		screen.getByText("Backend API");
	});

	it("shows the no-results message when the filter matches nothing", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.change(input, { target: { value: "zzz-no-match" } });

		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.queryByText(/No matches for/)).not.toBeNull();
	});

	it("includes the current query in the no-results message", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.change(input, { target: { value: "xyz" } });

		// Confirm the no-results text includes the typed query
		expect(screen.queryByText(/No matches for.*xyz/)).not.toBeNull();
	});

	it("calls onChange with correct id+branch when Enter is pressed on highlighted item", async () => {
		const client = makeClient();
		const onChange = vi.fn();
		render(<TargetPicker client={client} projectId="p1" onChange={onChange} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);

		// Wait for options — highlight defaults to index 0 = TARGETS[0]
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("1", "main");
	});

	it("moves highlight down with ArrowDown and selects with Enter", async () => {
		const client = makeClient();
		const onChange = vi.fn();
		render(<TargetPicker client={client} projectId="p1" onChange={onChange} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		// ArrowDown: highlight index 0 → 1 (Backend API / feat/api-v2)
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onChange).toHaveBeenCalledWith("2", "feat/api-v2");
	});

	it("closes the list on Escape and clears the query", async () => {
		const client = makeClient();
		render(<TargetPicker client={client} projectId="p1" onChange={vi.fn()} />);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.change(input, { target: { value: "end" } });
		expect((input as HTMLInputElement).value).toBe("end");

		fireEvent.keyDown(input, { key: "Escape" });

		// List closed — no options in DOM
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		// Query cleared
		expect((input as HTMLInputElement).value).toBe("");
	});

	it("marks the currently-selected option with aria-selected=true", async () => {
		const client = makeClient();
		render(
			<TargetPicker
				client={client}
				projectId="p1"
				value="2"
				onChange={vi.fn()}
			/>,
		);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		const options = screen.getAllByRole("option");
		// id "2" is index 1 in TARGETS
		expect(options[1].getAttribute("aria-selected")).toBe("true");
		expect(options[0].getAttribute("aria-selected")).toBe("false");
		expect(options[2].getAttribute("aria-selected")).toBe("false");
	});

	it("calls onChange(undefined, undefined) when clicking the selected option to deselect", async () => {
		const client = makeClient();
		const onChange = vi.fn();
		render(
			<TargetPicker
				client={client}
				projectId="p1"
				value="1"
				onChange={onChange}
			/>,
		);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		// First option is the selected one (id "1")
		const selectedOption = screen.getAllByRole("option")[0];
		fireEvent.mouseDown(selectedOption);

		expect(onChange).toHaveBeenCalledWith(undefined, undefined);
	});

	it("clears the selection via keyboard on the × button and returns focus to the input", async () => {
		const client = makeClient();
		const onChange = vi.fn();
		render(
			<TargetPicker
				client={client}
				projectId="p1"
				value="1"
				onChange={onChange}
			/>,
		);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		const clearBtn = screen.getByLabelText("Clear selection");
		// Keyboard users must be able to reach the button (tabIndex 0, not -1).
		expect(clearBtn.getAttribute("tabindex")).toBe("0");
		// Enter/Space on a <button> dispatch a click natively.
		fireEvent.click(clearBtn);

		expect(onChange).toHaveBeenCalledWith(undefined, undefined);
		// Focus returns to the input after clearing.
		expect(document.activeElement).toBe(input);
	});

	it("clears the selection when Escape is pressed with a value selected", async () => {
		const client = makeClient();
		const onChange = vi.fn();
		render(
			<TargetPicker
				client={client}
				projectId="p1"
				value="1"
				onChange={onChange}
			/>,
		);

		const input = screen.getByRole("combobox");
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

		fireEvent.keyDown(input, { key: "Escape" });

		expect(onChange).toHaveBeenCalledWith(undefined, undefined);
		expect(screen.queryAllByRole("option")).toHaveLength(0);
	});
});
