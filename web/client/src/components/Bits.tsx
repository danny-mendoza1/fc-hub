import { ago, KIND_LABELS, STALE_AFTER_MS } from "../format.ts";
import ui from "./ui.module.css";

const KIND_CLASS: Record<string, string | undefined> = {
  character: ui.character,
  retainer: ui.retainer,
  freeCompany: ui.freeCompany,
  housing: ui.housing,
};

export function KindBadge({ kind }: { kind: string }) {
  return <span className={`${ui.badge} ${KIND_CLASS[kind] ?? ui.unknown}`}>{KIND_LABELS[kind] ?? kind}</span>;
}

export function HqBadge() {
  return <span className={`${ui.badge} ${ui.hq}`}>HQ</span>;
}

/** Relative time with the exact timestamp on hover; amber once the data is a week old. */
export function Age({ iso }: { iso: string }) {
  const stale = Date.now() - Date.parse(iso) > STALE_AFTER_MS;
  return (
    <span className={stale ? `${ui.age} ${ui.stale}` : ui.age} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </span>
  );
}

export function Holder({ kind, name }: { kind: string; name: string | null }) {
  return (
    <div className={ui.holder}>
      <KindBadge kind={kind} />
      <span>{name ?? "(unnamed)"}</span>
    </div>
  );
}
