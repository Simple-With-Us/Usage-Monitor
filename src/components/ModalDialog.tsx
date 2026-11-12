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

interface DialogA11yOptions {
  onClose: () => void;
  closeDisabled?: boolean;
  /**
   * Capture-phase handling with stopImmediatePropagation. Required when this
   * dialog can stack ABOVE another dialog that registered its own document
   * keydown listener first (e.g. the integration drawer over AddProviderModal)
   * — without it, Escape/Tab would reach the underlying dialog's handler.
   */
  capture?: boolean;
}

/**
 * Shared dialog accessibility machinery (U10): initial focus, focus trap,
 * Escape-to-close, body scroll lock, and focus restoration on unmount.
 */
function useDialogA11y(
  dialogRef: React.RefObject<HTMLElement | null>,
  { onClose, closeDisabled = false, capture = false }: DialogA11yOptions
) {
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
      if (capture && (event.key === "Escape" || event.key === "Tab")) {
        // Intercept before any underlying dialog's document-level handler.
        event.stopImmediatePropagation();
      }
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

    document.addEventListener("keydown", handleKeyDown, capture);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, capture);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
    // `dialogRef` is stable; capture changes require a remount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

interface ModalDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
  closeDisabled?: boolean;
  /**
   * "modal" (default) renders the centered card with a built-in header.
   * "side-panel" renders a right-side drawer: full height, no built-in
   * header, and capture-phase key handling so it can stack above a modal.
   */
  variant?: "modal" | "side-panel";
  /**
   * Id of an element INSIDE `children` that names the dialog (side-panels
   * render their own header). Falls back to an internal visually-hidden
   * heading built from `title`.
   */
  labelledBy?: string;
  /** Optional id of an element that describes the dialog (aria-describedby). */
  describedBy?: string;
}

export default function ModalDialog({
  title,
  onClose,
  children,
  maxWidthClass,
  closeDisabled = false,
  variant = "modal",
  labelledBy,
  describedBy,
}: ModalDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, {
    onClose,
    closeDisabled,
    capture: variant === "side-panel",
  });

  if (variant === "side-panel") {
    return (
      <div
        className="fixed inset-0 z-50 flex justify-end bg-gray-950/40"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !closeDisabled) onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy ?? titleId}
          aria-describedby={describedBy}
          tabIndex={-1}
          className={`h-full w-full overflow-y-auto bg-white shadow-2xl outline-none dark:bg-gray-800 ${maxWidthClass ?? "max-w-xl"}`}
        >
          {labelledBy ? null : (
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
          )}
          {children}
        </div>
      </div>
    );
  }

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
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`relative max-h-[calc(100dvh-1.5rem)] w-full overflow-y-auto rounded-2xl bg-white shadow-xl dark:bg-gray-800 sm:max-h-[90vh] ${maxWidthClass ?? "max-w-lg"}`}
      >
        <div className="p-4 sm:p-6">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label={`Close ${title}`}
              className="min-h-10 min-w-10 rounded-lg text-2xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
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
