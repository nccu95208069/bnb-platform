"use client";
import { useEffect, useRef } from "react";
export function Modal({
  label,
  locked = false,
  onClose,
  children,
}: {
  label: string;
  locked?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 backdrop:bg-black/30"
    >
      <div className="flex min-h-full items-center justify-center p-3">
        {children}
      </div>
    </dialog>
  );
}
