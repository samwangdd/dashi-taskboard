import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionContext } from "../scripts/claude-session-context.mjs";

test("a SessionStart payload becomes taskctl attribution context", () => {
  const output = buildSessionContext({
    session_id: "6f1c2d34-5678-4abc-9def-0123456789ab",
    hook_event_name: "SessionStart",
    source: "startup",
  });

  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /--thread-id 6f1c2d34-5678-4abc-9def-0123456789ab/,
  );
});

test("a payload without a session id produces no context", () => {
  assert.equal(buildSessionContext({ hook_event_name: "SessionStart" }), null);
  assert.equal(buildSessionContext({ session_id: "   " }), null);
  assert.equal(buildSessionContext(null), null);
});

test("an oversized session id is rejected", () => {
  assert.equal(buildSessionContext({ session_id: "a".repeat(257) }), null);
});
