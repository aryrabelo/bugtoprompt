#!/usr/bin/env bash
# Builds a universal (arm64 + x86_64) BugToPrompt.app and packages it into a
# drag-to-Applications .dmg (issue #59, PRD §10 Distribution).
#
# Signing and notarization are env-gated and OPTIONAL. With no APPLE_* secrets
# set, this produces an unsigned, un-notarized .dmg and still exits 0 (local/dev
# builds and unsigned CI). When the secrets are present it imports the Developer
# ID certificate into a throwaway keychain, codesigns, then notarizes+staples.
#
# Secrets consumed (all optional; see .context/handoff.md "Human dependency"):
#   APPLE_CERTIFICATE           base64 of the Developer ID .p12 (for keychain import)
#   APPLE_CERTIFICATE_PASSWORD  password protecting that .p12
#   APPLE_SIGNING_IDENTITY      e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_ID / APPLE_PASSWORD   Apple ID + app-specific password (notarytool)
#   APPLE_TEAM_ID               Apple Developer team id (notarytool)
#
# No secret VALUE is ever echoed; only presence is checked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${TRAY_DIR}"

DIST_DIR="${TRAY_DIR}/dist"
APP_DIR="${DIST_DIR}/BugToPrompt.app"
CONTENTS_DIR="${APP_DIR}/Contents"

# Single cleanup path for every temp artifact (bash 3.2 safe: no arrays).
STAGING_DIR=""
KEYCHAIN_DIR=""
KEYCHAIN_PATH=""
CERT_P12=""
KEYCHAIN_CREATED="false"
cleanup() {
	[ -n "${STAGING_DIR}" ] && rm -rf "${STAGING_DIR}"
	[ -n "${CERT_P12}" ] && rm -f "${CERT_P12}"
	if [ "${KEYCHAIN_CREATED}" = "true" ] && [ -n "${KEYCHAIN_PATH}" ]; then
		security delete-keychain "${KEYCHAIN_PATH}" 2>/dev/null || true
	fi
	[ -n "${KEYCHAIN_DIR}" ] && rm -rf "${KEYCHAIN_DIR}"
	return 0
}
trap cleanup EXIT

# 1. Read version from Cargo.toml (first `version = "..."` under [package]).
VERSION="$(grep -m1 '^version' Cargo.toml | sed -E 's/version[[:space:]]*=[[:space:]]*"([^"]+)"/\1/')"
if [ -z "${VERSION}" ]; then
	echo "error: could not parse version from ${TRAY_DIR}/Cargo.toml" >&2
	exit 1
fi
echo "Packaging BugToPrompt version ${VERSION}"

# 2. Clean dist/.
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

# 3. Build both targets in release.
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin

# 4. Universal binary via lipo.
ARM64_BIN="${TRAY_DIR}/target/aarch64-apple-darwin/release/sidecar-tray"
X86_64_BIN="${TRAY_DIR}/target/x86_64-apple-darwin/release/sidecar-tray"
lipo -create -output "${DIST_DIR}/BugToPrompt" "${ARM64_BIN}" "${X86_64_BIN}"
echo "Universal binary info:"
lipo -info "${DIST_DIR}/BugToPrompt"

# 5. Assemble the .app bundle.
mkdir -p "${CONTENTS_DIR}/MacOS" "${CONTENTS_DIR}/Resources"
cp "${DIST_DIR}/BugToPrompt" "${CONTENTS_DIR}/MacOS/BugToPrompt"
chmod +x "${CONTENTS_DIR}/MacOS/BugToPrompt"
sed "s/__VERSION__/${VERSION}/g" "${TRAY_DIR}/packaging/Info.plist" >"${CONTENTS_DIR}/Info.plist"
plutil -lint "${CONTENTS_DIR}/Info.plist"

# 6. Import the Developer ID cert into a throwaway keychain (env-gated). Without
# this, codesign cannot find the identity in CI (no login keychain holds it).
# Skipped entirely when APPLE_CERTIFICATE is absent, so the unsigned path is
# untouched. The keychain is deleted by the EXIT trap.
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
	KEYCHAIN_DIR="$(mktemp -d)"
	KEYCHAIN_PATH="${KEYCHAIN_DIR}/build.keychain-db"
	KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
	CERT_P12="$(mktemp).p12"
	printf '%s' "${APPLE_CERTIFICATE}" | base64 --decode >"${CERT_P12}"
	security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"
	security set-keychain-settings -lut 21600 "${KEYCHAIN_PATH}"
	security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"
	security import "${CERT_P12}" -k "${KEYCHAIN_PATH}" -P "${APPLE_CERTIFICATE_PASSWORD}" -T /usr/bin/codesign
	security set-key-partition-list -S apple-tool:,apple: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null
	# Make codesign search the temp keychain first, keeping the existing ones.
	# shellcheck disable=SC2046
	security list-keychains -d user -s "${KEYCHAIN_PATH}" $(security list-keychains -d user | sed 's/[[:space:]]*"//g')
	rm -f "${CERT_P12}"
	CERT_P12=""
	KEYCHAIN_CREATED="true"
	echo "imported signing certificate into a throwaway keychain"
fi

# 7. Signing (env-gated, graceful).
SIGNED="false"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
	codesign --force --deep --options runtime --timestamp \
		--sign "${APPLE_SIGNING_IDENTITY}" "${APP_DIR}"
	codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
	echo "signed BugToPrompt.app"
	SIGNED="true"
else
	echo "NOTICE: APPLE_SIGNING_IDENTITY absent - building UNSIGNED .app (local/dev only; Gatekeeper will warn)"
fi

# 8. Create the DMG with a drag-to-Applications layout.
DMG_PATH="${DIST_DIR}/BugToPrompt.dmg"
STAGING_DIR="$(mktemp -d)"
cp -R "${APP_DIR}" "${STAGING_DIR}/BugToPrompt.app"
ln -s /Applications "${STAGING_DIR}/Applications"
hdiutil create -volname "BugToPrompt" -srcfolder "${STAGING_DIR}" -ov -format UDZO "${DMG_PATH}"
echo "Created ${DMG_PATH}"

# 9. Notarization (env-gated, graceful): only when the app is signed AND all
# notarytool credentials are present.
NOTARIZED="false"
if [ "${SIGNED}" = "true" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
	xcrun notarytool submit "${DMG_PATH}" \
		--apple-id "${APPLE_ID}" \
		--password "${APPLE_PASSWORD}" \
		--team-id "${APPLE_TEAM_ID}" \
		--wait
	xcrun stapler staple "${DMG_PATH}"
	echo "notarized and stapled ${DMG_PATH}"
	NOTARIZED="true"
else
	echo "NOTICE: notarization skipped - signing/notarization secrets absent (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID)"
fi

# 10. Final summary + universal proof.
echo "----------------------------------------"
echo "BugToPrompt packaging summary"
echo "  version:    ${VERSION}"
echo "  signed:     ${SIGNED}"
echo "  notarized:  ${NOTARIZED}"
echo "  dmg:        ${DMG_PATH}"
ls -lh "${DMG_PATH}"
echo "  universal binary proof:"
lipo -info "${CONTENTS_DIR}/MacOS/BugToPrompt"
echo "----------------------------------------"

exit 0
