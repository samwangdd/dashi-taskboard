export function executionPathValues(value) {
  const values = new Set();
  function visit(item) {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string" && (key === "workspacePath" || ((key === "sessionId" || key === "legacyLocalThreadId") && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(child)))) values.add(child);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(value);
  return [...values];
}

export function cloudExecutionOwner(owner, fingerprint) {
  if (!owner) return owner;
  if (owner.platform === "codex" && owner.workspacePath) {
    const { workspacePath, ...identity } = owner;
    return { ...identity, workspaceKey: fingerprint(workspacePath) };
  }
  if (owner.sessionId && executionPathValues(owner).includes(owner.sessionId)) {
    const { sessionId, ...identity } = owner;
    return { ...identity, sessionKey: fingerprint(sessionId) };
  }
  return structuredClone(owner);
}

export function cloudExecutionState(state, fingerprint) {
  if (!state) return state;
  const copy = structuredClone(state);
  if (copy.active) copy.active.owner = cloudExecutionOwner(copy.active.owner, fingerprint);
  copy.history = (copy.history ?? []).map(entry => ({ ...entry, owner: cloudExecutionOwner(entry.owner, fingerprint) }));
  if (copy.origins?.threadBinding?.workspacePath) {
    const { workspacePath, ...identity } = copy.origins.threadBinding;
    copy.origins.threadBinding = { ...identity, workspaceKey: fingerprint(workspacePath) };
  }
  if (copy.origins?.agentSession) copy.origins.agentSession = cloudExecutionOwner(copy.origins.agentSession, fingerprint);
  if (copy.origins?.legacyLocalThreadId && executionPathValues(copy.origins).includes(copy.origins.legacyLocalThreadId)) {
    copy.origins.legacyLocalSessionKey = fingerprint(copy.origins.legacyLocalThreadId);
    copy.origins.legacyLocalThreadId = null;
  }
  return copy;
}
