import type { ReactNode } from "react";
import styles from "./PageBanner.module.css";

/** Decorative FC photography beside the page heading and optional live details. */
export function PageBanner({ title, image, children }: { title: string; image: string; children?: ReactNode }) {
  return (
    <header className={styles.banner}>
      <div className={styles.caption}>
        <h2>{title}</h2>
        {children}
      </div>
      <img src={image} alt="" className={styles.photo} />
    </header>
  );
}
