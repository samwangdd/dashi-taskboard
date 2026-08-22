# Taskboard

Taskboard coordinates durable work across users, agents, development workspaces, and delivery workflows.

## Coding Delivery

**Development Context**:
The current branch or worktree where an issue is being implemented. It may change as work is isolated or moved.
_Avoid_: Target branch, delivery branch

**Target Branch**:
The stable branch that receives an issue's delivered changes. Changing it requires an explicit retarget decision.
_Avoid_: Current branch, worktree branch

**Task Branch**:
The branch checked out in an issue-specific worktree while the issue is being implemented.
_Avoid_: Target branch, base branch

**Start Revision**:
The repository revision frozen when a Coding run begins and used as that run's evidence baseline.
_Avoid_: Target branch, latest revision
