import type { AgentKind } from "./types";

export type AgentHarness = "codex-desktop" | "claude-desktop" | "kiro-cli-orca";

export const AGENT_HARNESSES: ReadonlyArray<{ harness: AgentHarness; label: string }> = [
  { harness: "codex-desktop", label: "Codex" },
  { harness: "claude-desktop", label: "Claude Code" },
  { harness: "kiro-cli-orca", label: "Kiro" },
];

export function agentKindForHarness(harness: AgentHarness): AgentKind {
  if (harness === "codex-desktop") return "codex";
  if (harness === "claude-desktop") return "claude-code";
  return "unknown";
}

export function harnessForAgentKind(agentKind: AgentKind | null | undefined): AgentHarness | null {
  if (agentKind === "codex") return "codex-desktop";
  if (agentKind === "claude-code") return "claude-desktop";
  return null;
}

export function canOpenConversationInAgent(agentKind: AgentKind | null | undefined): boolean {
  return agentKind === "codex" || agentKind === "claude-code";
}

export function resumeCommandForAgent(
  agentKind: AgentKind | null | undefined,
  threadId: string,
): string | null {
  if (agentKind === "codex") return `codex resume ${threadId}`;
  if (agentKind === "claude-code") return `claude --resume ${threadId}`;
  return null;
}
