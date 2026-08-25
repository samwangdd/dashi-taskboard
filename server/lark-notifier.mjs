import { execFile } from "node:child_process";
import path from "node:path";

const NOTIFIED_STATUSES = new Map([
  ["in_review", "🟢Ready for review"],
  ["blocked", "🚨Blocked"],
]);

function buildIssueLink(boardUrl, task) {
  const url = new URL(boardUrl);
  url.searchParams.set("project", task.projectId);
  url.searchParams.set("issue", task.identifier.toUpperCase());
  return url.toString();
}

function formatMessage(task, previousStatus, boardUrl, projectName) {
  return [
    `${NOTIFIED_STATUSES.get(task.status)} · ${task.identifier} ${task.title}`,
    `Project: ${projectName}`,
    `Status: ${previousStatus} → ${task.status}`,
    buildIssueLink(boardUrl, task),
  ].join("\n");
}

function runCommand(command, args) {
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

export function createLarkNotifier({
  userId,
  boardUrl,
  command = "lark-cli",
  run = runCommand,
} = {}) {
  return {
    onTaskStatusChange(task, previousStatus, project) {
      if (!userId || !NOTIFIED_STATUSES.has(task.status) || task.status === previousStatus) return;

      const report = (error) => {
        const exit = typeof error?.code === "number" ? `exit ${error.code}` : "see lark-cli output";
        console.error(`Lark notification failed for ${task.identifier} (${exit})`);
      };
      try {
        Promise.resolve(run(command, [
          "im",
          "+messages-send",
          "--as",
          "bot",
          "--user-id",
          userId,
          "--text",
          formatMessage(task, previousStatus, boardUrl, project.name),
        ])).catch(report);
      } catch (error) {
        report(error);
      }
    },
  };
}
