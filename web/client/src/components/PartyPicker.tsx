import type { ReactNode } from "react";
import ui from "./ui.module.css";

export interface PartyOption<K> {
  key: K;
  label: string;
  /** Hover text, e.g. a journal's status. */
  title?: string;
  /** Shown before the label, e.g. a status dot. */
  marker?: ReactNode;
}

/** A row of toggle chips for choosing who to compare (Wondrous Tails, Items in common). */
export function PartyPicker<K extends string | number>({
  label,
  ariaLabel,
  options,
  selected,
  onToggle,
}: {
  label: string;
  ariaLabel: string;
  options: PartyOption<K>[];
  selected: ReadonlySet<K>;
  onToggle: (key: K) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset's legend can't sit in a flex row of chips; role="group" gives the same semantics.
    <div className={ui.party} role="group" aria-label={ariaLabel}>
      <span className={ui.partyLabel}>{label}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={ui.chip}
          aria-pressed={selected.has(o.key)}
          onClick={() => onToggle(o.key)}
          title={o.title}
        >
          {o.marker}
          {o.label}
        </button>
      ))}
    </div>
  );
}
