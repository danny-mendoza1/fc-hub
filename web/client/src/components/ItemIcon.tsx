import { useState } from "react";
import styles from "./ItemIcon.module.css";

/**
 * Game item icon via the API's icon proxy (same origin, so the CSP stays `img-src 'self'`).
 * Lazy-loaded; falls back to a neutral tile when the item has no icon or it fails to load.
 */
export function ItemIcon({ iconId, size = "small" }: { iconId: number; size?: "small" | "large" }) {
  const [failed, setFailed] = useState(false);
  const className = `${styles.icon} ${size === "large" ? styles.large : styles.small}`;

  if (!iconId || failed) return <span className={`${className} ${styles.placeholder}`} aria-hidden="true" />;

  return (
    <img className={className} src={`/api/v1/icons/${iconId}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}
