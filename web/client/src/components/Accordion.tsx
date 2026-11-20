import { type ReactNode, useState } from "react";
import styles from "./Accordion.module.css";

interface Props {
  summary: ReactNode;
  /** Rendered only after the first time the panel is opened, so its data loads lazily. */
  children: () => ReactNode;
  defaultOpen?: boolean;
  level?: "owner" | "section";
}

/**
 * Native <details>/<summary> accordion (keyboard and screen-reader support for free) with a
 * rotating chevron. Content mounts on first open and stays mounted, so re-opening is instant.
 */
export function Accordion({ summary, children, defaultOpen = false, level = "owner" }: Props) {
  const [opened, setOpened] = useState(defaultOpen);
  return (
    <details
      className={`${styles.details} ${level === "section" ? styles.section : styles.owner}`}
      open={defaultOpen || undefined}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className={styles.summary}>
        <Chevron />
        <div className={styles.summaryBody}>{summary}</div>
      </summary>
      {opened && <div className={styles.panel}>{children()}</div>}
    </details>
  );
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
