export function buildTaskPrompt(identifier: string): string {
  return `e-taskboard Handle Taskboard issue ${identifier} and keep its progress status synchronized.`;
}
