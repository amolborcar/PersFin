# KevFin desktop app

A standalone macOS desktop build of KevFin (Electron) — no terminal needed. It
bundles the server + client and opens a native window. Everything stays local;
the storage location is user-choosable (e.g. a cloud-synced or NAS folder) so
data can be backed up or moved between machines. macOS is the only supported
platform.

## Run it from source (dev)

```bash
npm run desktop          # builds client + server, then launches the app window
```

The server runs as a child process under the system Node in dev; the window opens
at the server's port (3001, or the next free one).

## Build installers

```bash
npm run desktop:dist     # builds, stages, and packages the macOS app
```

Output lands in `desktop/dist-app/` as `KevFin-<version>-arm64.dmg`.

The app is **unsigned**. On first launch, right-click the app → **Open** →
**Open** (one-time Gatekeeper bypass).

### How packaging works (the moving parts)

- `desktop/scripts/stage.js` assembles a production server copy under
  `desktop/staging/` and rebuilds **better-sqlite3** for Electron's ABI (the
  repo's own `node_modules`, built for system Node, is left untouched).
- `desktop/scripts/afterPack.js` copies the staged `node_modules` into the bundle
  (electron-builder strips `node_modules` from `extraResources`).
- Config: `desktop/electron-builder.yml`.

> better-sqlite3 must be **≥ 12** — older versions don't compile against
> Electron 33's V8 headers.

## Build in CI

The **Desktop build** workflow (`.github/workflows/desktop-build.yml`) builds the
macOS app on a macOS runner and uploads the `.dmg` as an artifact:

- Run it from the repo's **Actions → Desktop build → Run workflow**, or
- push a tag: `git tag v1.0.0 && git push origin v1.0.0`.

Download the `KevFin-macos` artifact from the run.

## Choosing where data lives

In the app: **Setup (⚙) → Storage location → Change folder…**. Pick any folder —
a cloud-synced or NAS folder keeps your database and keys file backed up or synced.
The app copies the files there and relaunches.

> Don't run KevFin on two computers against the same synced file at the same time
> — SQLite allows only one writer.

Under the hood the desktop app sets `DB_PATH` and `KEVFIN_ENV_PATH` for the server;
both default to the app's per-user data folder until you change them.

## AI assistant

The assistant runs on **your own Claude subscription**, not a paid API key. Sign in
once from the assistant's login gate:

- **Any OS:** run `claude setup-token` and paste the token into the gate, or
- **macOS:** click "Log in to Claude" to open a terminal and run `/login`.

The token is saved to your keys file (so it travels with your chosen storage
location). The rest of the app works normally whether or not you sign in.

**The `claude` binary is bundled.** `stage.js` fetches the matching native
Claude Code binary (a pinned per-platform npm package, `CLAUDE_VERSION`) and the
app points `CLAUDE_BIN` at it — so the assistant works out of the box after
sign-in, with nothing to install. Bump `CLAUDE_VERSION` in `desktop/scripts/stage.js`
to update it. (This is why the installers are large — the binary is ~200 MB.)
