#!/usr/bin/env node
// DEPRECATED: this npx entrypoint is retired in favor of the Chrome
// extension + Rust tray sidecar (Lite tier). No longer shipped in the
// published npm package (see package.json `files`); kept in-tree for
// reference until the Rust tray reaches feature parity.
// Thin bin wrapper: starts the BugToPrompt local sidecar. The service module
// boots its HTTP listener on import (see server/github-issue-service.mjs).
import "../server/github-issue-service.mjs";
