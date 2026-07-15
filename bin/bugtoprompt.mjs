#!/usr/bin/env node
// Thin bin wrapper: starts the BugToPrompt local sidecar. The service module
// boots its HTTP listener on import (see server/github-issue-service.mjs).
import "../server/github-issue-service.mjs";
