# ADR 0006: Pinned dependencies and supply-chain checks

- **Status:** Accepted.
- **Date:** 2026-11-20

## Context

FC Hub runs third-party code in three places: npm packages (the React bundle in members' browsers, and the build and deploy tooling that holds Cloudflare credentials), NuGet packages (plugin tests), and GitHub Actions (CI and the release that publishes the plugin every member installs). Version ranges and movable tags mean what runs can change without a commit in this repo. A newly published malicious version is usually caught and removed within days, but only if nobody installed it first.

## Decision

1. **Everything is pinned to an exact version or hash.**
   - npm: exact versions in `web/package.json` (`web/.npmrc` sets `save-exact`), plus `package-lock.json` (integrity hashes). CI installs with `npm ci`.
   - NuGet: exact `PackageReference` versions, plus `packages.lock.json` for every project (`plugin/Directory.Build.props`). CI restores in locked mode, so a dependency change without a lock update fails.
   - GitHub Actions: full commit SHAs with the version in a comment (`uses: actions/checkout@<sha> # v7.0.1`). A tag can be moved to other code; a SHA can't.
   - Dalamud reference assemblies (what the plugin compiles against): one commit of `goatcorp/dalamud-distrib`, checked by SHA-256 (`.github/actions/dalamud-reference`). Moving to a newer Dalamud is a deliberate one-PR change; Dependabot can't see it.
2. **Updates wait 14 days; security fixes don't.** Dependabot version updates for npm, NuGet and Actions use `cooldown: default-days: 14`, so a release has two weeks to be caught and yanked before we're offered it. Cooldown doesn't apply to Dependabot *security* updates, which open as soon as an advisory exists (the repository setting "Dependabot security updates" must be on).
3. **Known vulnerabilities fail CI.**
   - `npm audit --audit-level=high` fails on high or critical advisories.
   - NuGet audit (`NuGetAuditMode=all`) treats high (NU1903) and critical (NU1904) as build errors, transitive packages included.
   - CI also runs weekly on a schedule, so a new advisory against something already merged shows up without a PR.
4. **Less ambient trust in CI.**
   - `npm ci --ignore-scripts`: dependencies' install scripts don't run in CI. Nothing CI uses needs them: esbuild's only re-checks its binary, and workerd's is for `wrangler dev`.
   - `actions/checkout` with `persist-credentials: false`, so later steps can't read the job token from `.git/config`.
   - Workflow tokens are scoped: `contents: read` for CI, and `contents: write` only for the release job.

## Consequences

- Adding or bumping a dependency always changes a lock file, and is reviewable as such.
- A high or critical advisory with no fix yet blocks CI until it's upgraded, removed, or knowingly accepted. Accepting one is a deliberate change: an `npm audit` exception or a NuGet `NuGetAuditSuppress` entry, with a comment saying why.
- Dependabot PRs arrive two weeks later than before. Security fixes don't.
- Repository settings this relies on, outside the code: Dependabot security updates, secret scanning and push protection (on), and ideally a ruleset requiring CI to pass on `main`.
