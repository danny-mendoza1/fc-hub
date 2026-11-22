import { useEffect } from "react";
import type { OverviewCharacter } from "../../../src/api-types.ts";
import hall from "../art/fc-hall.webp";
import { bySectionOrder, numberFormat, SECTION_LABELS } from "../format.ts";
import { useApi } from "../hooks.ts";
import { prefetchView, queries } from "../queries.ts";
import { Accordion } from "./Accordion.tsx";
import { Age, Holder } from "./Bits.tsx";
import { ItemsInCommon } from "./ItemsInCommon.tsx";
import styles from "./OverviewView.module.css";
import { OwnerItemsPanel } from "./OwnerItemsPanel.tsx";
import { PageBanner } from "./PageBanner.tsx";
import ui from "./ui.module.css";

export function OverviewView() {
  // "Items in common" (rendered once the overview is in) starts loading now, not after it.
  useEffect(() => prefetchView("overview"), []);
  const state = useApi(queries.overview);

  return (
    <section>
      <PageBanner title="Inventories" image={hall} />
      <p className={ui.muted}>
        Open a row to browse its items. Each section shows when it was last captured in game; retainers and the FC chest refresh when
        someone opens them. Something out of date? Type <code>/fchub upload</code> in game to send yours now.
      </p>
      {state.status === "loading" && (
        <p role="status" className={ui.muted}>
          Loading…
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className={ui.error}>
          {state.message}
        </p>
      )}
      {state.status === "done" && state.data.characters.length === 0 && (
        <p className={ui.muted}>Nobody has uploaded yet. Turn on uploads in the plugin's settings (/fchub config).</p>
      )}
      {state.status === "done" && state.data.characters.length > 0 && (
        <>
          <ItemsInCommon />
          <h2 id="inventories" tabIndex={-1} className={styles.inventoryHeading}>
            Individual inventories
          </h2>
        </>
      )}
      {state.status === "done" && state.data.characters.map((c) => <CharacterCard key={c.contentId} character={c} />)}
    </section>
  );
}

function CharacterCard({ character: c }: { character: OverviewCharacter }) {
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
          {() => <OwnerItemsPanel ownerId={o.ownerId} />}
        </Accordion>
      ))}
    </article>
  );
}
