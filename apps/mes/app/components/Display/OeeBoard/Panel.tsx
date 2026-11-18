// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { cn } from "@carbon/react";

/** One zone of the board: a dark card with a small heading row. */
export function Panel({
  title,
  aside,
  className,
  label,
  children
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "min-w-0 overflow-hidden rounded-[10px] border border-white/10 bg-zinc-900 px-[1em] py-[0.8em]",
        className
      )}
    >
      <p className="mb-[0.5em] flex justify-between gap-[0.5em] text-[0.85em] font-medium text-white/55">
        {/* The title keeps its width; a long note gives way first. */}
        <span className="max-w-full shrink-0 truncate">{title}</span>
        {aside ? (
          <span className="min-w-0 truncate text-right">{aside}</span>
        ) : null}
      </p>
      {children}
    </section>
  );
}

/** A horizontal bar of a share from 0 to 1. */
export function Bar({
  value,
  fill,
  className
}: {
  value: number;
  fill: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-[0.55em] overflow-hidden rounded-full bg-white/10",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          fill
        )}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  );
}
