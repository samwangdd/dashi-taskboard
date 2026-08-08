import { execFile } from "node:child_process";
import path from "node:path";

export const NOTIFIED_STATUSES = new Map([
  ["in_review", "🔍 待审核"],
  ["blocked", "⛔ 被阻塞"],
]);

// Mirrors buildIssueUrl in web/src/issueRoute.ts so the link opens the issue detail.
export function buildIssueLink(boardUrl, task) {
  const url = new URL(boardUrl);
  url.searchParams.set("project", task.projectId);
  url.searchParams.set("issue", task.identifier.toUpperCase());
  return url.toString();
}

export function formatLarkMessage(task, previousStatus, boardUrl) {
  return [
    `${NOTIFIED_STATUSES.get(task.status)} · ${task.identifier} ${task.title}`,
    `项目：${task.projectId}`,
    `状态：${previousStatus} → ${task.status}`,
    buildIssueLink(boardUrl, task),
  ].join("\n");
}

function execFileRunner(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function createLarkNotifier({ userId, boardUrl, command = "lark-cli", run = execFileRunner } = {}) {
  return {
    onTaskStatusChange(task, previousStatus) {
      if (!userId) return;
      if (!NOTIFIED_STATUSES.has(task.status)) return;
      if (task.status === previousStatus) return;

      const report = (error) => {
        console.error(`Lark notification failed for ${task.identifier}: ${error.message}`);
      };
      // A notification failure must never surface as a taskboard API error.
      try {
        Promise.resolve(run(command, [
          "im",
          "+messages-send",
          "--as",
          "bot",
          "--user-id",
          userId,
          "--text",
          formatLarkMessage(task, previousStatus, boardUrl),
        ])).catch(report);
      } catch (error) {
        report(error);
      }
    },
  };
}
