#!/usr/bin/env node
import { readFileSync } from "node:fs";

const MAX_SESSION_ID_LENGTH = 256;

export function buildSessionContext(payload) {
  const raw = payload?.session_id;
  if (typeof raw !== "string") return null;
  const sessionId = raw.trim();
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Taskboard 会话归属：当前 Claude Code session id 为 ${sessionId}。`
        + ` 用 taskctl 做任何 issue / relation / comment 变更时，附带 --thread-id ${sessionId}。`,
    },
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === new URL(`file://${entry}`).href;
}

if (isDirectRun()) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const output = buildSessionContext(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}
