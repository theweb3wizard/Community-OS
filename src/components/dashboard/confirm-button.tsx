"use client";

import { useState } from "react";

export function ConfirmButton({
  action,
  label,
  confirmLabel,
  warning,
  hidden,
  className,
}: {
  action: (formData: FormData) => void;
  label: string;
  confirmLabel: string;
  warning?: string;
  hidden: Record<string, string>;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={className}>
        {label}
      </button>
    );
  }
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {warning ? <span className="text-xs text-red-600">{warning}</span> : null}
      <button type="submit" className={className}>
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
      >
        Cancel
      </button>
    </form>
  );
}
