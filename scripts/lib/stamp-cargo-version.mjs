/**
 * Version stamping for the sidecar-tray crate so a release cut carries ONE
 * version across npm (package.json), the extension (manifest stamped from
 * package.json in extension/scripts/build.mjs) and the tray DMG (which reads
 * the version from sidecar-tray/Cargo.toml in scripts/package-dmg.sh:46).
 *
 * Both functions are pure (string in → string out) so they are unit-testable
 * without touching the filesystem, and both touch ONLY the crate's own version
 * — never a dependency's inline `version = "..."`, which a naive global replace
 * would silently corrupt.
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertSemver(version) {
	if (!SEMVER.test(version)) {
		throw new Error(`Invalid semver version "${version}".`);
	}
}

/**
 * Replace the `version = "..."` under the `[package]` table of a Cargo.toml.
 * Dependency tables (`[dependencies]`, inline `{ version = "..." }`) are left
 * untouched. Returns the updated file content.
 */
export function stampPackageVersion(content, version) {
	assertSemver(version);
	const lines = content.split("\n");
	let inPackage = false;
	let replaced = false;
	for (let i = 0; i < lines.length; i++) {
		const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
		if (header) {
			inPackage = header[1] === "package";
			continue;
		}
		if (inPackage && !replaced && /^\s*version\s*=/.test(lines[i])) {
			lines[i] = lines[i].replace(
				/version\s*=\s*"[^"]*"/,
				`version = "${version}"`,
			);
			replaced = true;
		}
	}
	if (!replaced) {
		throw new Error("No [package] version found in Cargo.toml.");
	}
	return lines.join("\n");
}

/**
 * Update the `version = "..."` for a specific crate's `[[package]]` entry in a
 * Cargo.lock, so the lockfile does not go dirty on the next `cargo build`
 * (package-dmg.sh builds the tray, which would otherwise rewrite the pin after
 * the release). Returns the updated file content.
 */
export function stampLockVersion(content, crateName, version) {
	assertSemver(version);
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== `name = "${crateName}"`) {
			continue;
		}
		// Walk the rest of this [[package]] block until the next table header.
		for (let j = i + 1; j < lines.length && !/^\s*\[\[/.test(lines[j]); j++) {
			if (/^\s*version\s*=/.test(lines[j])) {
				lines[j] = lines[j].replace(
					/version\s*=\s*"[^"]*"/,
					`version = "${version}"`,
				);
				return lines.join("\n");
			}
		}
		throw new Error(`No version line for crate "${crateName}" in Cargo.lock.`);
	}
	throw new Error(`Crate "${crateName}" not found in Cargo.lock.`);
}
