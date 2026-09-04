import type { ActorIdentity } from "../types";
import { actorDisplayName } from "../actors";

export function ActorAvatar({
  actor,
  className = "",
}: {
  actor: ActorIdentity;
  className?: string;
}) {
  const agentLogo = actor.agentKind === "claude-code"
    ? "claude-code-agent-logo.svg"
    : actor.agentKind === "codex"
      ? "codex-agent-logo.png"
      : "ai-agent-logo.svg";
  return (
    <span
      className={`actor-avatar actor-avatar-${actor.type}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      title={actorDisplayName(actor)}
    >
      {actor.type === "agent" ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src={agentLogo}
          alt=""
        />
      ) : actor.avatarUrl ? (
        <img
          className="actor-avatar-image"
          src={actor.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : actor.name.slice(0, 1)}
    </span>
  );
}
