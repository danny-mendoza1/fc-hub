import { useEffect, useState } from "react";
import type { OverviewCharacter } from "../../../src/api-types.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import { bySectionOrder, numberFormat, SECTION_LABELS } from "../format.ts";
import { Accordion } from "./Accordion.tsx";
import { Age, Holder } from "./Bits.tsx";
import { OwnerItemsPanel } from "./OwnerItemsPanel.tsx";
import ui from "./ui.module.css";
import styles from "./OverviewView.module.css";

type State = { status: "loading" } | { status: "done"; characters: OverviewCharacter[] } | { status: "error"; message: string };

export function OverviewView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .overview()
      .then(({ characters }) => !cancelled && setState({ status: "done", characters }))
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Unauthorized) return onUnauthorized();
        setState({ status: "error", message: `Couldn't load: ${errorMessage(error)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  return (
    <section>
      <p className={ui.muted}>
        Open a row to browse its items. Each section shows when it was last captured in game; retainers and the FC chest refresh
        when someone opens them.
      </p>
      {state.status === "loading" && <p className={ui.muted}>Loading…</p>}
      {state.status === "error" && <p className={ui.error}>{state.message}</p>}
      {state.status === "done" && state.characters.length === 0 && (
        <p className={ui.muted}>Nobody has uploaded yet. Turn on uploads in the plugin's settings (/fchub config).</p>
      )}
      {state.status === "done" &&
        state.characters.map((c) => <CharacterCard key={c.contentId} character={c} onUnauthorized={onUnauthorized} />)}
    </section>
  );
}

function CharacterCard({ character: c, onUnauthorized }: { character: OverviewCharacter; onUnauthorized: () => void }) {
  return (
    <article className={`${ui.card} ${styles.character}`}>
      <h3>
        {c.name}
        {c.homeWorld && ` @ ${c.homeWorld}`}
      </h3>
      <p className={ui.muted}>
        {c.member} · last upload <Age iso={c.lastUploadAt} />
      </p>
      {c.owners.map((o) => (
        <Accordion
          key={o.ownerId}
          summary={
            <div className={styles.owner}>
              <Holder kind={o.kind} name={o.name} />
              <div className={styles.sections}>
                {[...o.sections].sort(bySectionOrder).map((s) => (
                  <span key={s.section}>
                    {SECTION_LABELS[s.section] ?? s.section}: {numberFormat.format(s.itemCount)} · <Age iso={s.capturedAt} />
                  </span>
                ))}
              </div>
            </div>
          }
        >
          {() => <OwnerItemsPanel ownerId={o.ownerId} onUnauthorized={onUnauthorized} />}
        </Accordion>
      ))}
    </article>
  );
}
