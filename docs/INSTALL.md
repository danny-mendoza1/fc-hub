# Installing FC Hub (for FC members)

FC Hub shares what's in your bags, retainers and the FC chest with the rest of the FC. Once it's set up, anyone can search the FC Hub website to see **who has an item, how many, and where**.

You need FFXIV on PC through **XIVLauncher** with the in-game add-on (Dalamud) enabled, plus your **personal FC Hub key** (starts with `fch_`) and the **FC Hub website address**. Danny gives you both. Keep the key private: it's your password for FC Hub.

## 1. Install Allagan Tools

FC Hub reads your inventory through Allagan Tools.

1. In game, type `/xlplugins`.
2. Search **Allagan Tools**, then **Install**.

## 2. Add the FC Hub plugin repository (one time)

1. Type `/xlsettings` and open the **Experimental** tab.
2. Scroll to **Custom Plugin Repositories** and paste this URL into the empty box:
   ```
   https://github.com/danny-mendoza1/fc-hub/releases/latest/download/pluginmaster.json
   ```
3. Click **+**, make sure **Enabled** is ticked, then **Save and Close**.

Dalamud warns that custom repositories aren't reviewed by the Dalamud team. That's expected for a private FC plugin; the code is public at https://github.com/danny-mendoza1/fc-hub.

## 3. Install FC Hub

1. `/xlplugins`, search **FC Hub**, then **Install**. Updates arrive automatically, like any other plugin.
2. Type `/fchub config` (or click the cog next to FC Hub in `/xlplugins`).
3. Paste the **Server URL** and your **API key**, then click **Test connection**. You should see "Connected as *your name*".
4. Tick **Upload my inventories automatically**, then **Save**.

## 4. Let it see your stuff

Allagan Tools only learns what's in a retainer or the FC chest once you've opened it:

- Visit a **summoning bell** and open **each retainer** once.
- Open the **FC chest** once, if you have access.
- Saddlebags, armoire and glamour dresser: open them once too, if you want them shared.

After that, FC Hub keeps everything up to date as you play: changes go up within about a minute. You only need to reopen a retainer to refresh it after changing its contents somewhere FC Hub can't see.

## 5. Wondrous Tails (optional)

FC Hub also shares your **Wondrous Tails** journal so the FC can find duties you have in common. It uses **one character per person**: the first one you log in with after installing. To share a different character's journal, log into it and use **Share Wondrous Tails from … instead** in `/fchub config`. Alts are otherwise ignored.

## 6. Search

Open the FC Hub website, sign in with the same key, and search. **Who's uploaded** shows how fresh everyone's data is.

## Troubleshooting

| Problem | Fix |
|---|---|
| FC Hub window says Allagan Tools isn't loaded | Install or enable Allagan Tools in `/xlplugins` |
| "HTTP 401 … uploads paused" | Key typo or revoked key. Re-paste it in `/fchub config` and Save, or ask Danny for a new one |
| A retainer is missing on the website | Open that retainer at a summoning bell, then wait a minute |
| Want to force an upload | `/fchub upload` |
