/**
 * Every field occupies exactly one line of the instruction, so a value that
 * carries newlines or other control characters could otherwise forge extra
 * lines and steer the agent. Collapse them into single spaces rather than
 * dropping the value: the field keeps its meaning, and it can no longer break
 * out of its own line.
 */
function clean(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Build the text that prefills the Codex composer when an issue is opened in a
 * thread. The block names the project, the issue, and the workspace so the
 * agent knows what it is looking at, then points it at `taskctl` for the title,
 * the description, and the comments rather than embedding a copy that can go
 * stale.
 */
export function buildThreadInstruction({
  identifier,
  projectName,
  projectId,
  workspacePath,
} = {}) {
  const issue = clean(identifier);
  const name = clean(projectName);
  const id = clean(projectId);
  const workspace = clean(workspacePath);

  const project = name && id ? `${name} (id: ${id})` : name || id;
  const fields = [
    project ? `- 项目: ${project}` : "",
    issue ? `- 议题: ${issue}` : "",
    workspace ? `- 工作区: ${workspace}` : "",
  ].filter(Boolean);

  return [
    "处理下面这个议题：",
    "",
    ...fields,
    "",
    `先执行 taskctl issue get ${issue} 读取标题、描述与评论，再开始。`,
  ].join("\n");
}
