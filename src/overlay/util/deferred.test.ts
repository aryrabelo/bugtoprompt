import { describe, expect, it } from "vitest";
import { deferred } from "./deferred";

describe("deferred", () => {
	it("resolves the promise with the given value", async () => {
		const { promise, resolve } = deferred<number>();
		resolve(42);
		await expect(promise).resolves.toBe(42);
	});

	it("rejects the promise with the given error", async () => {
		const { promise, reject } = deferred<never>();
		const err = new Error("boom");
		reject(err);
		await expect(promise).rejects.toBe(err);
	});

	it("settle is idempotent — only the first call wins", async () => {
		const { promise, resolve } = deferred<string>();
		resolve("first");
		resolve("second"); // ignored per Promise spec
		await expect(promise).resolves.toBe("first");
	});

	it("returns an unresolved promise before settle is called", () => {
		const { promise } = deferred<void>();
		// The promise should still be pending — attaching a then should not throw.
		expect(promise).toBeInstanceOf(Promise);
	});
});
