import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";

export type LoopPromptKind = "automation" | "delivery" | "triage";

interface LoopPromptMenuProps {
  disabled: boolean;
  pending: boolean;
  unavailableReason: string | null;
  onCopy: (promptKind: LoopPromptKind) => void;
}

const OPTIONS: ReadonlyArray<{
  kind: LoopPromptKind;
  label: string;
  description: string;
}> = [
  {
    kind: "automation",
    label: "Current automation",
    description: "The same prompt used by the automation button.",
  },
  {
    kind: "delivery",
    label: "High-frequency delivery",
    description: "Ship approved work, then fill one available todo slot.",
  },
  {
    kind: "triage",
    label: "Project triage",
    description: "Repair stale states and relations without executing work.",
  },
];

export function LoopPromptMenu({
  disabled,
  pending,
  unavailableReason,
  onCopy,
}: LoopPromptMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu loop-prompt-menu no-drag"
      role="menu"
      aria-label="Copy loop prompt"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>Copy loop prompt</strong>
      </div>
      <div className="loop-prompt-menu-options">
        {OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              onCopy(option.kind);
            }}
          >
            <LinearIcon name="copy" />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        className={`copy-loop-prompt-trigger no-drag${open ? " is-open" : ""}`}
        type="button"
        disabled={disabled}
        aria-busy={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Copy loop prompt"
        title={unavailableReason ?? "Copy loop prompt"}
        onClick={() => {
          if (!open) setPosition({ left: 0, top: 0, ready: false });
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="copy" />
        <span>loop prompt</span>
        <LinearIcon name="chevronDown" />
      </button>
      {menu}
    </>
  );
}
