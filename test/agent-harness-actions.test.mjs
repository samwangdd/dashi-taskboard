import assert from "node:assert/strict";
import test from "node:test";

import {
  agentKindForHarness,
  harnessForAgentKind,
  resumeCommandForAgent,
} from "../web/src/agentHarnesses.ts";

test("agent activity actions use the matching harness and resume command", () => {
  assert.equal(harnessForAgentKind("codex"), "codex-desktop");
  assert.equal(harnessForAgentKind("claude-code"), "claude-desktop");
  assert.equal(harnessForAgentKind("unknown"), null);
  assert.equal(agentKindForHarness("codex-desktop"), "codex");
  assert.equal(agentKindForHarness("claude-desktop"), "claude-code");
  assert.equal(agentKindForHarness("kiro-cli-orca"), "unknown");
  assert.equal(resumeCommandForAgent("codex", "thread-123"), "codex resume thread-123");
  assert.equal(resumeCommandForAgent("claude-code", "session-456"), "claude --resume session-456");
  assert.equal(resumeCommandForAgent("unknown", "legacy-789"), null);
});
