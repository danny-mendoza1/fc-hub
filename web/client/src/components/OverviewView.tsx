import type { OverviewCharacter } from "../../../src/api-types.ts";
import { api } from "../api.ts";
import { bySectionOrder, numberFormat, SECTION_LABELS } from "../format.ts";
import { useApi } from "../hooks.ts";
import { Accordion } from "./Accordion.tsx";
import { Age, Holder } from "./Bits.tsx";
import { ItemsInCommon } from "./ItemsInCommon.tsx";
import styles from "./OverviewView.module.css";
import { OwnerItemsPanel } from "./OwnerItemsPanel.tsx";
import ui from "./ui.module.css";

export function OverviewView() {
  const state = useApi((signal) => api.overview(signal), [], { cacheKey: "overview" });

  return (
    <section>
      <p className={ui.muted}>
        Open a row to browse its items. Each section shows when it was last captured in game; retainers and the FC chest refresh when
        someone opens them. Something out of date? Type <code>/fchub upload</code> in game to send yours now.
      </p>
      {state.status === "loading" && <p className={ui.muted}>Loading…</p>}
      {state.status === "error" && <p className={ui.error}>{state.message}</p>}
      {state.status === "done" && state.data.characters.length === 0 && (
        <p className={ui.muted}>Nobody has uploaded yet. Turn on uploads in the plugin's settings (/fchub config).</p>
      )}
      {state.status === "done" && state.data.characters.length > 0 && <ItemsInCommon />}
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
