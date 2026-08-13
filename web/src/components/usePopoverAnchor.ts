import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface PopoverPosition {
  left: number;
  top: number;
  ready: boolean;
}

/**
 * Anchors a portalled popover under a trigger button: measures once the popover
 * is mounted, flips above the trigger when it would overflow, and closes on
 * outside pointerdown, Escape, resize, or scroll. Tab is deliberately left alone
 * so focus can move through the popover's own fields.
 */
export function usePopoverAnchor(open: boolean, onClose: () => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, ready: false });

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
        onClose();
      }
    }
    function closeFromViewportChange() {
      onClose();
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
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
  }, [onClose, open]);

  const resetPosition = () => setPosition((current) => ({ ...current, ready: false }));

  return { triggerRef, menuRef, position, resetPosition };
}
