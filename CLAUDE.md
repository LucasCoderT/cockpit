@AGENTS.md

# Working on this fork

`LucasCoderT/cockpit` is a fork for a remote desk: the Herdr app on one machine (the desk) is the window for Claude
Code sessions that run on others (runners), each with cockpit's hub. `FORK.md` says what the fork adds and
`docs/app.md` ("A remote desk", "Several hubs in one window") how it works; read them before changing the desk, the
hub's TCP side, `app/mods/cockpit/extra.js` or anything that names a terminal by address.

## The person's setup

- The desk is a MacBook; the runner is a Mac Studio named `studio` in Herdr (`hc machine ls`). Both have a checkout at
  `~/Developer/cockpit` on `main`; one is the working copy, the other pulls.
- The desk's `~/.config/herdr-app/cockpit.json` reads studio's hub and lists the MacBook's own as `extra` (named
  `macbook`). Studio's `~/.config/cockpit/config.json` says `"window": "desk"`, `"hubForward"` (its Tailscale IP) and
  `"hubPort": 47821`, with `tailscale serve --tcp 47821` forwarding to the hub on loopback.
- `AGENTS.md` still holds: check GUI work in the sandbox, and leave the live window, hub and config alone. Deploying to
  the live setup (below) is for when the person asks for it.

## Deploying

- `sh scripts/desk.sh build` builds the release binary into `~/.config/cockpit/herdr/bin` on the machine it runs on.
  Rust changes need it on both machines.
- `sh scripts/desk.sh desk studio --with-local` on the desk installs this checkout's mod into the Herdr app and
  rewrites `cockpit.json` (it keeps the local hub's name). Mod-only changes need just this, or
  `cockpit app install --from "$PWD/app"`, which keeps the remote desk.
- `sh scripts/desk.sh runner` on a runner sets `window`, `hubForward` and `hubPort` and restarts its hub.
- From the desk, run things on studio with `hc exec --on studio --timeout 600 sh -lc '…'`: `hc exec` stops a command
  after 60 seconds otherwise, which a cargo build outlasts.
- Studio's own Herdr window also runs the mod: after a mod change, `cockpit app install --from "$PWD/app"` there too.

## Things that bite

- Never click or run cockpit's "Update" (`update.sh`): it runs upstream's herdr plugin updater and puts upstream's
  binary back over the fork's. The fork publishes its own releases (`scripts/cut-release.sh`, then push `main`).
- The hub replaces its environment with the login shell's at start (`herdr/tui/cli/src/hub_env.rs`): settings a hub
  needs go in `~/.config/cockpit/config.json` (`files::setting`), not in environment variables.
- macOS's firewall holds incoming connections for cockpit's ad-hoc-signed binary after every rebuild; that is why a
  runner's hub listens on loopback behind `tailscale serve` (`hubForward`) rather than on its Tailscale IP.
- A runner names its terminals by its own addresses (`t4`), the desk by its own (`studio/t4`): requests to a runner go
  through `hub.runnerArgs`, and what comes back is brought to desk addresses (`fleet.rowsOf`, `chat.deskChat`). A
  driven session's key (`claude:…`) is the same on both ends.
- Mod tests load modules in a VM with stubbed imports: a new import in a module may need a stub in the test fixtures
  (`hub-leak.test.mjs` stubs `./extra.js`; `extra.js` takes `net` from hub.js rather than importing it).
- `app/tests/hub-leak.test.mjs` "a read that keeps giving up with no timer…" is flaky (about 2 runs in 6) on upstream's
  code too.
- `hc send` delivers text as a message, so it cannot run a slash command such as `/reload-plugins`.

## Keeping up with upstream

`git fetch upstream && git merge upstream/main`, then bump past upstream's version with `sh scripts/cut-release.sh
patch` so installs take the fork's build. Keep fork-only notes here and in `FORK.md`, not in `AGENTS.md`, so merges
stay clean.
