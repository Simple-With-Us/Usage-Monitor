"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
  closeDisabled?: boolean;
}

export default function ModalDialog({
  title,
  onClose,
  children,
  maxWidthClass = "max-w-lg",
  closeDisabled = false,
}: ModalDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = dialogRef.current;
    const initial =
      dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]:not([disabled])") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    initial?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabledRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative max-h-[calc(100dvh-1.5rem)] w-full overflow-y-auto rounded-2xl bg-white shadow-xl sm:max-h-[90vh] ${maxWidthClass}`}
      >
        <div className="p-4 sm:p-6">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-xl font-semibold text-gray-900">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label={`Close ${title}`}
              className="min-h-10 min-w-10 rounded-lg text-2xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              &times;
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
