import type { ReactNode } from "react";

/** A titled block inside the side panel. */
export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {aside && <span className="text-[11px] text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  name: string;
}

/** A radio group drawn as a two- or three-way switch. Arrow keys move between options natively. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: SegmentedProps<T>) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col rounded-md border border-border bg-bg p-0.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={`cursor-pointer rounded px-2 py-1.5 text-center text-xs font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent ${
              option.value === value
                ? "bg-accent/15 font-semibold text-accent ring-1 ring-accent/50 ring-inset"
                : "text-muted hover:text-fg"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Stat({
  label,
  value,
  hint,
  big = false,
}: {
  label: string;
  value: string;
  hint?: string;
  /** The headline figures: larger value, sentence-case label. */
  big?: boolean;
}) {
  return (
    <div className={big ? "shrink-0" : "min-w-0"}>
      <dt
        className={
          big
            ? "text-[11px] text-muted"
            : "truncate text-[10px] font-medium uppercase tracking-wide text-muted"
        }
      >
        {label}
      </dt>
      <dd
        className={
          big
            ? "whitespace-nowrap text-lg font-semibold tabular-nums leading-tight"
            : "truncate font-mono text-sm font-semibold tabular-nums"
        }
        title={hint}
      >
        {value}
      </dd>
    </div>
  );
}

/** A secondary figure set inline, "Descent 3,870 ft". */
export function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt>{label}</dt>
      <dd className="font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
      <span>{label}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
