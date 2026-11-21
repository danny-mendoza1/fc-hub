# Releasing

## Plugin

1. Bump `<Version>` in `plugin/FcHub/FcHub.csproj` (four parts, e.g. `0.2.2.0`) in the PR that ships the change.
2. After it's merged, tag `main` with the same version and push the tag:
   ```bash
   git checkout main && git pull
   git tag v0.2.2.0
   git push origin v0.2.2.0
   ```
3. The **Release plugin** workflow builds in Release mode and publishes a GitHub Release with `latest.zip` and `pluginmaster.json`. It fails if the tag and `<Version>` don't match.
4. Players get the update automatically. Dalamud checks `…/releases/latest/download/pluginmaster.json`, which always points at the newest release.

Dalamud only offers an update when `AssemblyVersion` goes **up**, so never reuse a version.

### Your own machine: dev build vs. installed build

The dev build (Dev Plugin Locations) and the repository build share the internal name `FcHub`, so only one can be loaded at a time. Play with the installed one, and when you're working on the plugin, disable it in `/xlplugins` before enabling the dev build. Both use the same settings file, so your URL and key carry over.

## Web

```bash
cd web
npm run db:migrate:remote   # only when the PR added a migration
npm run deploy
```

## After a game patch: moving to a newer Dalamud

CI compiles against one pinned Dalamud build (`.github/actions/dalamud-reference/action.yml`), so a Dalamud update never breaks an unrelated PR. When the plugin needs a newer Dalamud (a new API level, or new game data), update the commit, version and SHA-256 there in one PR. The file has the three commands to get them. If the API level changes, bump `Dalamud.NET.Sdk` in `plugin/FcHub/FcHub.csproj` in the same PR.
