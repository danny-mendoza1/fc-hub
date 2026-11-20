# Test plan 03 — Wondrous Tails (plugin v0.3.0)

**Goal:** confirm the plugin reads the journal correctly in every state, and the website shows books and duties in common.

## Setup
1. Merge the PR, then in `web/`: `npm run db:migrate:remote` (adds the `wondrous_tails` table) **before** `npm run deploy`.
2. Release the plugin: `git tag v0.3.0.0 && git push origin v0.3.0.0`. Players update in `/xlplugins`.
3. In game: `/fchub` → expand **Wondrous Tails** at the bottom.

## Checks

| # | Question | How | Record |
|---|---|---|---|
| 1 | Is the journal readable without opening it? | Log in, wait ~15 s, don't open the journal | Section shows a status (not "Waiting…") |
| 2 | Does "no journal" (already turned in) read correctly? | With this week's book turned in | "No journal…" after ~20 s; the website shows **Turned in** or **No journal** |
| 3 | Do 16 objectives with the right names show? | With a journal | Names match the in-game journal; hover a row for order/type/data ids |
| 4 | Are statuses right? | Compare with the journal | Done-with-sticker = "Done (sticker placed)", completed-but-unplaced = "Done (place sticker)" |
| 5 | Is the expiry right? | Note "Journal expires …" | This week's book: the Tuesday *after* next. Last week's: the coming Tuesday |
| 6 | Are stickers / second chances right? | Compare with the journal | Match |
| 7 | Do alts stay out? | Log into an alt | "Not shared from this character (sharing <main>)"; nothing uploaded |
| 8 | Can the sharing character be switched? | `/fchub config` on the alt → "Share Wondrous Tails from … instead" | The website shows the alt's journal; switch back afterwards |
| 9 | Does the website match? | **Wondrous Tails** tab | Badge (This week's / Last week's / Turned in / No journal), "Turn in by", stickers, second chances, 4×4 grid with done slots faded |
| 10 | Does "in common" work? | Select you + one FC mate, then all | List and gold-highlighted slots match the overlap; toggling a member updates instantly; the choice survives a reload |
| 11 | Does a hand-in get detected? | Turn in a book while the plugin runs | Within ~1–2 min the website shows **Turned in** |

Also check `/xllog` for `[FcHub]` errors.
