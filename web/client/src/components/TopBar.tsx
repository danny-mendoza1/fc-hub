import type { Member } from "../../../src/api-types.ts";
import { VIEWS, type View } from "../views.ts";
import styles from "./TopBar.module.css";
import ui from "./ui.module.css";

interface Props {
  member: Member | null;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
}

export function TopBar({ member, view, onNavigate, onSignOut }: Props) {
  return (
    <header className={styles.topbar}>
      <h1 className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          ◆
        </span>{" "}
        FC Hub
      </h1>
      {member && (
        <>
          <nav className={styles.tabs}>
            {VIEWS.map((tab) => (
              <button
                key={tab.view}
                type="button"
                className={styles.tab}
                aria-current={tab.view === view ? "page" : undefined}
                onClick={() => onNavigate(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className={styles.session}>
            <span>{member.displayName}</span>
            <button type="button" className={ui.linkButton} onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </>
      )}
    </header>
  );
}
