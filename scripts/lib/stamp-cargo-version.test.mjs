import { describe, expect, it } from "vitest";
import {
	stampLockVersion,
	stampPackageVersion,
} from "./stamp-cargo-version.mjs";

const CARGO_TOML = `[package]
name = "sidecar-tray"
version = "0.1.0"
edition = "2024"

[dependencies]
tao = { version = "0.35", default-features = false }
tokio = { version = "1", features = ["rt"] }
serde = { version = "1", features = ["derive"] }
`;

const CARGO_LOCK = `[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "sidecar-tray"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "tao"
version = "0.35.0"
`;

describe("stampPackageVersion", () => {
	it("rewrites only the [package] version", () => {
		const out = stampPackageVersion(CARGO_TOML, "0.14.1");
		expect(out).toContain('name = "sidecar-tray"\nversion = "0.14.1"');
	});

	it("never touches dependency inline versions (the corruption bug)", () => {
		const out = stampPackageVersion(CARGO_TOML, "0.14.1");
		// A naive /version = "[^"]*"/g global replace would clobber these.
		expect(out).toContain('tao = { version = "0.35"');
		expect(out).toContain('tokio = { version = "1"');
		expect(out).toContain('serde = { version = "1"');
	});

	it("accepts prerelease semver", () => {
		const out = stampPackageVersion(CARGO_TOML, "0.14.0-beta.7");
		expect(out).toContain('version = "0.14.0-beta.7"');
	});

	it("rejects a non-semver version", () => {
		expect(() => stampPackageVersion(CARGO_TOML, "latest")).toThrow(
			/Invalid semver/,
		);
	});

	it("throws when there is no [package] version", () => {
		expect(() =>
			stampPackageVersion('[dependencies]\nfoo = "1"\n', "1.0.0"),
		).toThrow(/No \[package\] version/);
	});
});

describe("stampLockVersion", () => {
	it("rewrites only the target crate's version", () => {
		const out = stampLockVersion(CARGO_LOCK, "sidecar-tray", "0.14.1");
		expect(out).toContain('name = "sidecar-tray"\nversion = "0.14.1"');
	});

	it("leaves sibling crate versions untouched", () => {
		const out = stampLockVersion(CARGO_LOCK, "sidecar-tray", "0.14.1");
		expect(out).toContain('name = "serde"\nversion = "1.0.200"');
		expect(out).toContain('name = "tao"\nversion = "0.35.0"');
	});

	it("throws when the crate is absent", () => {
		expect(() => stampLockVersion(CARGO_LOCK, "nope", "1.0.0")).toThrow(
			/not found in Cargo.lock/,
		);
	});
});
