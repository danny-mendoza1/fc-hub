import { useEffect, useMemo, useState } from "react";
import type { BookStatus, CommonDuty, WondrousTailsResponse, WtBook, WtSlot } from "../../../src/api-types.ts";
import { commonDuties, isActive } from "../../../src/wondrous-tails.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import { ago } from "../format.ts";
import { usePersistentState } from "../hooks.ts";
import { ItemIcon } from "./ItemIcon.tsx";
import ui from "./ui.module.css";
import styles from "./WondrousTailsView.module.css";

type State = { status: "loading" } | { status: "done"; data: WondrousTailsResponse } | { status: "error"; message: string };

const STATUS: Record<BookStatus, { label: string; tone: "good" | "warn" | "bad" | "muted" }> = {
  current: { label: "This week's journal", tone: "good" },
  previous: { label: "Last week's journal", tone: "warn" },
  expired: { label: "Expired journal", tone: "bad" },
  turnedIn: { label: "Turned in", tone: "muted" },
  none: { label: "No journal", tone: "muted" },
  unknown: { label: "Not shared yet", tone: "muted" },
};

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function WondrousTailsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  // null = never chosen: default to everyone with an active journal.
  const [savedParty, setSavedParty] = usePersistentState<number[] | null>("fchub.wt.party", () => null);

  useEffect(() => {
    let cancelled = false;
    api
      .wondrousTails()
      .then((data) => !cancelled && setState({ status: "done", data }))
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Unauthorized) return onUnauthorized();
        setState({ status: "error", message: `Couldn't load: ${errorMessage(error)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const books = state.status === "done" ? state.data.books : [];
  const party = useMemo(() => {
    if (savedParty !== null) return new Set(savedParty.filter((id) => books.some((b) => b.memberId === id)));
    return new Set(books.filter((b) => isActive(b.status)).map((b) => b.memberId));
  }, [savedParty, books]);
  const common = useMemo(() => commonDuties(books, party), [books, party]);
  // Highlight only what's worth running together: open for two or more of the party.
  const together = useMemo(() => new Set(common.filter((d) => d.needs.length >= 2).map((d) => d.orderId)), [common]);
  // The party's active journals first, then everyone else.
  const ordered = useMemo(
    () =>
      [...books].sort(
        (a, b) =>
          Number(party.has(b.memberId)) - Number(party.has(a.memberId)) ||
          Number(isActive(b.status)) - Number(isActive(a.status)) ||
          a.member.localeCompare(b.member),
      ),
    [books, party],
  );

  if (state.status === "loading") return <p className={ui.muted}>Loading…</p>;
  if (state.status === "error") return <p className={ui.error}>{state.message}</p>;

  const { lastReset, nextReset } = state.data;
  const toggle = (memberId: number) => {
    const next = new Set(party);
    if (next.has(memberId)) next.delete(memberId);
    else next.add(memberId);
    setSavedParty([...next]);
  };
  const activeInParty = books.filter((b) => party.has(b.memberId) && isActive(b.status)).length;

  return (
    <section>
      <p className={ui.muted}>
        Week of {new Date(lastReset).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · next reset{" "}
        <span title={dateTime.format(new Date(nextReset))}>{ago(nextReset)}</span>
      </p>

      <div className={ui.party} role="group" aria-label="Party members">
        <span className={ui.partyLabel}>Party</span>
        {books.map((b) => (
          <button
            key={b.memberId}
            type="button"
            className={ui.chip}
            aria-pressed={party.has(b.memberId)}
            onClick={() => toggle(b.memberId)}
            title={STATUS[b.status].label}
          >
            <span className={`${styles.dot} ${styles[STATUS[b.status].tone]}`} aria-hidden="true" />
            {b.member}
          </button>
        ))}
      </div>

      <CommonDuties duties={common} activeInParty={activeInParty} />

      <h2 className={styles.heading}>Journals</h2>
      <p className={`${ui.muted} ${styles.legend}`}>
        <span className={styles.legendSwatch} aria-hidden="true" /> needed by two or more of the party · faded = already done
      </p>
      <div className={styles.books}>
        {ordered.map((b) => (
          <BookCard key={b.memberId} book={b} inParty={party.has(b.memberId)} together={together} />
        ))}
      </div>
    </section>
  );
}

function CommonDuties({ duties, activeInParty }: { duties: CommonDuty[]; activeInParty: number }) {
  return (
    <article className={`${ui.card} ${styles.common}`}>
      <h2 className={styles.heading}>Duties in common</h2>
      {activeInParty < 2 ? (
        <p className={ui.muted}>Pick at least two party members who have a current journal.</p>
      ) : duties.length === 0 ? (
        <p className={ui.muted}>Nothing in common that someone still needs. Try a different party.</p>
      ) : (
        <ul className={styles.commonList}>
          {duties.map((d) => (
            <li key={d.orderId} className={styles.commonRow}>
              <ItemIcon iconId={d.iconId} size="large" />
              <div className={styles.commonBody}>
                <div className={styles.dutyName}>{d.name}</div>
                <div className={styles.who}>
                  <span className={styles.needs}>Needs: {d.needs.map((n) => n.member).join(", ")}</span>
                  {d.done.length > 0 && (
                    <span className={ui.muted}>
                      {" · "}Done:{" "}
                      {d.done
                        .map((x) => `${x.member}${x.secondChancePoints > 0 ? ` (${x.secondChancePoints} second chance${x.secondChancePoints === 1 ? "" : "s"})` : ""}`)
                        .join(", ")}
                    </span>
                  )}
                </div>
              </div>
              <span className={styles.count} title={`${d.needs.length} of the party still need this`}>
                {d.needs.length}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function BookCard({ book: b, inParty, together }: { book: WtBook; inParty: boolean; together: ReadonlySet<number> }) {
  const status = STATUS[b.status];
  return (
    <article className={`${ui.card} ${styles.book} ${inParty ? "" : styles.outOfParty}`}>
      <header className={styles.bookHead}>
        <div>
          <h3 className={styles.member}>{b.member}</h3>
          {b.character && (
            <div className={ui.muted}>
              {b.character}
              {b.homeWorld && ` @ ${b.homeWorld}`}
            </div>
          )}
        </div>
        <span className={`${ui.badge} ${styles[status.tone]}`}>{status.label}</span>
      </header>

      <BookMeta book={b} />

      {b.slots.length === 16 && (
        <ol className={styles.grid}>
          {b.slots.map((slot) => (
            <Slot key={slot.index} slot={slot} common={inParty && together.has(slot.orderId) && slot.status === "open"} />
          ))}
        </ol>
      )}
    </article>
  );
}

function BookMeta({ book: b }: { book: WtBook }) {
  const lines: string[] = [];
  if (b.status === "current" || b.status === "previous") {
    if (b.expiresAt) lines.push(`Turn in by ${dateTime.format(new Date(b.expiresAt))}`);
    lines.push(`${b.stickersPlaced}/9 stickers · ${b.secondChancePoints} second chance${b.secondChancePoints === 1 ? "" : "s"}`);
  } else if (b.status === "expired") {
    lines.push("Can't be turned in any more: trade it in with Khloe for a new one.");
  } else if (b.status === "turnedIn") {
    lines.push(b.newJournalAvailable ? "Turned in last week's journal. This week's is waiting at Khloe." : "Done for this week.");
  } else if (b.status === "none") {
    lines.push("A journal is available from Khloe in Idyllshire.");
  } else {
    lines.push("Hasn't shared Wondrous Tails yet (needs FC Hub 0.3 or newer).");
  }

  return (
    <div className={styles.meta}>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
      {b.capturedAt && (
        <div className={b.stale ? styles.staleNote : ui.muted}>
          As of {ago(b.capturedAt)}
          {b.stale && " (before this week's reset; they may have a new journal)"}
        </div>
      )}
    </div>
  );
}

function Slot({ slot, common }: { slot: WtSlot; common: boolean }) {
  const done = slot.status !== "open";
  const title = slot.status === "claimed" ? "Done, sticker placed" : slot.status === "claimable" ? "Done, sticker not placed yet" : "Not done";
  return (
    <li className={`${styles.slot} ${done ? styles.done : ""} ${common ? styles.inCommon : ""}`} title={`${slot.name}: ${title}`}>
      <ItemIcon iconId={slot.iconId} />
      <span className={styles.slotName}>{slot.name}</span>
      {done && (
        <span className={styles.check} aria-label={title}>
          ✓
        </span>
      )}
    </li>
  );
}
