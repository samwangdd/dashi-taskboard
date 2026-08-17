import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "../types";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";

interface IssueMentionMenuProps {
  anchor: HTMLTextAreaElement;
  anchorOffset: number;
  tasks: readonly Task[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (task: Task) => void;
  onClose: () => void;
}

export function IssueMentionMenu({
  anchor,
  anchorOffset,
  tasks,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onClose,
}: IssueMentionMenuProps) {
  const { text } = useTaskboardI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const portalTarget = anchor.closest("dialog") ?? document.body;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const textareaRect = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    const mirror = document.createElement("div");
    const mirroredProperties = [
      "border-bottom-width",
      "border-left-width",
      "border-right-width",
      "border-top-width",
      "box-sizing",
      "direction",
      "font-family",
      "font-size",
      "font-style",
      "font-weight",
      "letter-spacing",
      "line-height",
      "padding-bottom",
      "padding-left",
      "padding-right",
      "padding-top",
      "tab-size",
      "text-align",
      "text-indent",
      "text-transform",
      "word-spacing",
    ];
    mirror.style.position = "fixed";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.top = `${textareaRect.top}px`;
    mirror.style.left = `${textareaRect.left}px`;
    mirror.style.width = `${textareaRect.width}px`;
    mirror.style.borderStyle = "solid";
    mirror.style.borderColor = "transparent";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    for (const property of mirroredProperties) {
      mirror.style.setProperty(property, style.getPropertyValue(property));
    }
    mirror.textContent = anchor.value.slice(0, anchorOffset);
    const marker = document.createElement("span");
    marker.textContent = anchor.value.slice(anchorOffset, anchorOffset + 1) || "\u200b";
    mirror.append(marker);
    document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    const anchorRect = {
      left: markerRect.left - anchor.scrollLeft,
      top: markerRect.top - anchor.scrollTop,
      bottom: markerRect.bottom - anchor.scrollTop,
    };
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const openAbove = anchorRect.top - gap - menuRect.height >= edge;
    const left = Math.max(edge, Math.min(anchorRect.left, window.innerWidth - menuRect.width - edge));
    const top = openAbove ? anchorRect.top - menuRect.height - gap : anchorRect.bottom + gap;
    setPosition({ left, top: Math.max(edge, top) });
  }, [activeIndex, anchor, anchorOffset, tasks.length]);

  useLayoutEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (target !== anchor && !menuRef.current?.contains(target)) onClose();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="ai-chat-skill-menu issue-mention-menu"
      role="listbox"
      aria-label={text("引用议题", "Mention issue")}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {tasks.length > 0 ? tasks.map((task, index) => (
        <button
          className={index === activeIndex ? "is-selected" : ""}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-mention-index={index}
          key={task.id}
          onPointerEnter={() => onActiveIndexChange(index)}
          onClick={() => onSelect(task)}
        >
          <LinearIcon name="project" />
          <span>
            <strong>{task.externalKey ?? task.identifier}</strong>
            <small>{task.title}</small>
          </span>
        </button>
      )) : (
        <p className="issue-mention-empty">{text("没有匹配的议题", "No matching issues")}</p>
      )}
    </div>,
    portalTarget,
  );
}
