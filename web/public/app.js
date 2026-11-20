// @ts-check
// FC Hub web UI. No framework and no innerHTML: every value from the API is set via
// textContent, so item, character or retainer names can never inject markup.

/** @typedef {{ location: string, quantity: number }} Location */
/** @typedef {{ ownerId: string, ownerKind: string, ownerName: string | null, member: string, character: string, homeWorld: string | null, quantity: number, locations: Location[], updatedAt: string }} Holding */
/** @typedef {{ itemId: number, name: string, iconId: number, isHq: boolean, totalQuantity: number, holdings: Holding[] }} Hit */
/** @typedef {{ section: string, itemCount: number, capturedAt: string }} OverviewSection */
/** @typedef {{ ownerId: string, kind: string, name: string | null, sections: OverviewSection[] }} OverviewOwner */
/** @typedef {{ member: string, contentId: string, name: string, homeWorld: string | null, lastUploadAt: string, owners: OverviewOwner[] }} OverviewCharacter */

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_DEBOUNCE_MS = 250;

const KIND_LABELS = /** @type {Record<string, string>} */ ({
  character: "Character",
  retainer: "Retainer",
  freeCompany: "FC chest",
  housing: "House",
  unknown: "Other",
});

const SECTION_LABELS = /** @type {Record<string, string>} */ ({
  CharacterBags: "Inventory",
  CharacterSaddleBags: "Saddlebag",
  CharacterPremiumSaddleBags: "Premium saddlebag",
  CharacterArmoryChest: "Armoury chest",
  CharacterEquipped: "Equipped",
  RetainerBags: "Retainer bags",
  RetainerEquipped: "Retainer gear",
  RetainerMarket: "Market listings",
  FreeCompanyBags: "FC chest",
  GlamourChest: "Glamour dresser",
  Armoire: "Armoire",
  Currency: "Currency",
  Crystals: "Crystals",
  HousingInteriorItems: "Interior furnishings",
  HousingInteriorStoreroom: "Interior storeroom",
  HousingInteriorAppearance: "Interior fixtures",
  HousingExteriorItems: "Exterior furnishings",
  HousingExteriorStoreroom: "Exterior storeroom",
  HousingExteriorAppearance: "Exterior fixtures",
});

// --- tiny DOM helpers -------------------------------------------------------------------

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {{ className?: string, title?: string, text?: string | number }} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = String(props.text);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {string} id */
function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
}

const numberFormat = new Intl.NumberFormat();
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** @param {string} iso */
function ago(iso) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const units = /** @type {const} */ ([
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ]);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** @param {string} iso */
function ageCell(iso) {
  const stale = Date.now() - Date.parse(iso) > STALE_AFTER_MS;
  return el("span", { className: stale ? "age stale" : "age", title: new Date(iso).toLocaleString(), text: ago(iso) });
}

/** @param {string} kind */
function kindBadge(kind) {
  return el("span", { className: `badge ${kind in KIND_LABELS ? kind : "unknown"}`, text: KIND_LABELS[kind] ?? kind });
}

// --- API ----------------------------------------------------------------------------------

class Unauthorized extends Error {}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(path, init = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) throw new Unauthorized();
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}

// --- views ------------------------------------------------------------------------------

const views = /** @type {const} */ (["login", "search", "overview"]);

/** @param {(typeof views)[number]} name */
function show(name) {
  for (const view of views) $(`view-${view}`).hidden = view !== name;
  const signedIn = name !== "login";
  $("tabs").hidden = !signedIn;
  $("session").hidden = !signedIn;
  for (const tab of document.querySelectorAll(".tab")) {
    if (tab instanceof HTMLElement) {
      if (tab.dataset.view === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  }
  if (name === "search") /** @type {HTMLInputElement} */ ($("query")).focus();
  if (name === "overview") void loadOverview();
}

function signedOut() {
  show("login");
  /** @type {HTMLInputElement} */ ($("api-key")).focus();
}

/** @param {{ displayName: string }} member */
function signedIn(member) {
  $("member-name").textContent = member.displayName;
  show("search");
  const initial = new URL(location.href).searchParams.get("q");
  if (initial) {
    /** @type {HTMLInputElement} */ ($("query")).value = initial;
    void runSearch(initial);
  }
}

// --- search -----------------------------------------------------------------------------

/** @type {AbortController | null} */
let inFlight = null;
/** @type {number | undefined} */
let debounce;

/** @param {string} raw */
async function runSearch(raw) {
  const q = raw.trim();
  const url = new URL(location.href);
  if (q) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);

  const status = $("search-status");
  const results = $("results");
  inFlight?.abort();
  if (q.length < 2 && !/^\d+$/.test(q)) {
    status.textContent = q ? "Keep typing…" : "";
    results.replaceChildren();
    return;
  }

  inFlight = new AbortController();
  status.textContent = "Searching…";
  try {
    const data = await api(`/api/v1/search?q=${encodeURIComponent(q)}`, { signal: inFlight.signal });
    /** @type {Hit[]} */
    const hits = data.hits;
    const total = hits.reduce((sum, hit) => sum + hit.totalQuantity, 0);
    status.textContent = hits.length === 0
      ? `Nobody has anything matching "${q}" (as of their last upload).`
      : `${hits.length} item${hits.length === 1 ? "" : "s"} · ${numberFormat.format(total)} total${data.truncated ? " · showing the first matches, refine your search" : ""}`;
    results.replaceChildren(...hits.map(renderHit));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (error instanceof Unauthorized) return signedOut();
    status.textContent = `Search failed: ${error instanceof Error ? error.message : error}`;
  }
}

/** @param {Hit} hit */
function renderHit(hit) {
  const rows = hit.holdings.map((h) =>
    el(
      "tr",
      {},
      el("td", { className: "member", text: h.member }),
      el(
        "td",
        { className: "held-by" },
        el("div", { className: "holder" }, kindBadge(h.ownerKind), el("span", { text: h.ownerName ?? "(unnamed)" })),
        h.ownerKind === "retainer" ? el("div", { className: "muted", text: `${h.character}'s retainer` }) : null,
      ),
      el("td", { className: "qty", text: numberFormat.format(h.quantity) }),
      el(
        "td",
        { className: "where" },
        el("ul", { className: "locations" }, ...h.locations.map((l) => el("li", { text: h.locations.length > 1 ? `${numberFormat.format(l.quantity)} × ${l.location}` : l.location }))),
      ),
      el("td", { className: "updated" }, ageCell(h.updatedAt)),
    ),
  );

  return el(
    "article",
    { className: "card item" },
    el(
      "div",
      { className: "item-head" },
      el("span", { className: "item-name", text: hit.name || `Item #${hit.itemId}` }),
      hit.isHq ? el("span", { className: "badge hq", text: "HQ" }) : null,
      el("span", { className: "item-id", text: `#${hit.itemId}` }),
      el("span", { className: "item-total" }, "Total ", el("strong", { text: numberFormat.format(hit.totalQuantity) })),
    ),
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, el("th", { className: "member", text: "Member" }), el("th", { className: "held-by", text: "Held by" }), el("th", { className: "qty", text: "Qty" }), el("th", { className: "where", text: "Where" }), el("th", { className: "updated", text: "Updated" }))),
      el("tbody", {}, ...rows),
    ),
  );
}

// --- overview ---------------------------------------------------------------------------

async function loadOverview() {
  const container = $("overview");
  container.replaceChildren(el("p", { className: "muted", text: "Loading…" }));
  try {
    const data = await api("/api/v1/overview");
    /** @type {OverviewCharacter[]} */
    const characters = data.characters;
    if (characters.length === 0) {
      container.replaceChildren(el("p", { className: "muted", text: "Nobody has uploaded yet. Turn on uploads in the plugin's settings (/fchub config)." }));
      return;
    }
    container.replaceChildren(...characters.map(renderCharacter));
  } catch (error) {
    if (error instanceof Unauthorized) return signedOut();
    container.replaceChildren(el("p", { className: "error", text: `Couldn't load: ${error instanceof Error ? error.message : error}` }));
  }
}

/** @param {OverviewCharacter} c */
function renderCharacter(c) {
  return el(
    "article",
    { className: "card overview-character" },
    el("h3", { text: `${c.name}${c.homeWorld ? ` @ ${c.homeWorld}` : ""}` }),
    el("p", { className: "muted" }, `${c.member} · last upload `, ageCell(c.lastUploadAt)),
    ...c.owners.map((o) =>
      el(
        "div",
        { className: "overview-owner" },
        el("div", { className: "holder" }, kindBadge(o.kind), el("span", { text: o.name ?? "(unnamed)" })),
        el(
          "div",
          { className: "sections" },
          ...o.sections.map((s) => el("span", {}, `${SECTION_LABELS[s.section] ?? s.section}: ${numberFormat.format(s.itemCount)} · `, ageCell(s.capturedAt))),
        ),
      ),
    ),
  );
}

// --- wiring -----------------------------------------------------------------------------

function init() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = /** @type {HTMLInputElement} */ ($("api-key"));
    const error = $("login-error");
    error.textContent = "";
    try {
      const data = await api("/api/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: input.value.trim() }),
      });
      input.value = "";
      signedIn(data.member);
    } catch (e) {
      error.textContent = e instanceof Unauthorized ? "That key isn't valid (or has been revoked)." : `Sign-in failed: ${e instanceof Error ? e.message : e}`;
    }
  });

  $("sign-out").addEventListener("click", async () => {
    await api("/api/v1/session", { method: "DELETE" }).catch(() => null);
    signedOut();
  });

  $("query").addEventListener("input", (event) => {
    const value = /** @type {HTMLInputElement} */ (event.target).value;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      const view = tab instanceof HTMLElement ? tab.dataset.view : undefined;
      if (view === "search" || view === "overview") show(view);
    });
  }

  api("/api/v1/me")
    .then((data) => signedIn(data.member))
    .catch(signedOut);
}

init();
