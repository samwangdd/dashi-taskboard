import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildTaskboardLoopPrompt,
  type AutomationIntervalMinutes,
} from "../../../shared/taskboard-automation.mjs";
import type { CodingWorkflowConfig } from "../types";
import { LinearIcon } from "./LinearIcon";
import { usePopoverAnchor } from "./usePopoverAnchor";

const LOOP_PROMPT_INTERVAL_KEY = "taskboard.loopPromptInterval.v1";
const DEFAULT_LOOP_INTERVAL_MINUTES = 60;
const INTERVAL_MINUTES_OPTIONS: AutomationIntervalMinutes[] = [5, 10, 15, 30, 60];

interface CopyLoopPromptMenuProps {
  projectId: string;
  projectName: string;
  workspacePath: string | null;
  skillPath: string;
  codingConfig: CodingWorkflowConfig | null;
  onCopy: (prompt: string) => void;
}

function readLoopIntervals(): Record<string, AutomationIntervalMinutes> {
  try {
    const value = JSON.parse(window.localStorage.getItem(LOOP_PROMPT_INTERVAL_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, AutomationIntervalMinutes] => (
        typeof entry[1] === "number"
        && INTERVAL_MINUTES_OPTIONS.includes(entry[1] as AutomationIntervalMinutes)
      ),
    ));
  } catch {
    return {};
  }
}

/**
 * Copies the taskboard polling prompt so it can be pasted into any agent's loop.
 * The Codex automation next to it writes a cron entry through the host bridge,
 * which only exists inside the Codex app; this button needs nothing but the skill
 * path and the project directory, so it also works in a plain browser.
 */
export function CopyLoopPromptMenu({
  projectId,
  projectName,
  workspacePath,
  skillPath,
  codingConfig,
  onCopy,
}: CopyLoopPromptMenuProps) {
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  const { triggerRef, menuRef, position, resetPosition } = usePopoverAnchor(open, closeMenu);
  const [intervals, setIntervals] = useState(readLoopIntervals);
  const intervalMinutes = intervals[projectId] ?? DEFAULT_LOOP_INTERVAL_MINUTES;

  const unavailableReason = !skillPath
    ? "任务面板还没有读取到 Skill 路径"
    : !workspacePath
      ? "请先在项目设置里填写项目目录"
      : null;

  useEffect(() => {
    if (unavailableReason) setOpen(false);
  }, [unavailableReason]);

  const changeInterval = (minutes: AutomationIntervalMinutes) => {
    setIntervals((current) => {
      const next = { ...current, [projectId]: minutes };
      try {
        window.localStorage.setItem(LOOP_PROMPT_INTERVAL_KEY, JSON.stringify(next));
      } catch {
        // A full or blocked storage quota must not stop the copy itself.
      }
      return next;
    });
  };

  const copyPrompt = () => {
    if (!workspacePath || !skillPath) return;
    onCopy(buildTaskboardLoopPrompt({
      intervalMinutes,
      projectName,
      taskboardProjectId: projectId,
      workspacePath,
      skillPath,
      ...(codingConfig ? { codingConfig } : {}),
    }));
    setOpen(false);
    triggerRef.current?.focus();
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu copy-loop-prompt-menu no-drag"
      role="dialog"
      aria-label="复制 loop prompt"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>复制 loop prompt</strong>
      </div>
      <label className="project-automation-field">
        <span>间隔</span>
        <select
          value={intervalMinutes}
          onChange={(event) => changeInterval(
            Number(event.target.value) as AutomationIntervalMinutes,
          )}
        >
          {INTERVAL_MINUTES_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>{minutes} 分钟</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="copy-loop-prompt-submit"
        onClick={copyPrompt}
      >
        <LinearIcon name="copy" />
        <span>复制 prompt</span>
      </button>
      <p className="project-automation-note">
        粘到任意 agent 的循环入口即可，正文不指定模型。
      </p>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="copy-loop-prompt-trigger no-drag"
        aria-label="复制 loop prompt"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={unavailableReason ?? "复制 loop prompt"}
        disabled={Boolean(unavailableReason)}
        onClick={() => {
          if (!open) resetPosition();
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="copy" />
        <span>复制 loop prompt</span>
      </button>
      {menu}
    </>
  );
}
