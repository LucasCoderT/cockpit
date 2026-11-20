# This fork

`LucasCoderT/cockpit` is cockpit for a **remote desk**: the Herdr app on one machine (the desk) as the window for
Claude Code sessions that run on others (runners), with cockpit's hub on each runner. Upstream's remote desk
(`docs/app.md`, "A remote desk") reads a runner's hub; this fork lets it act too.

## What it adds to upstream

- **The two-way remote desk** from [creatorofuniverses/cockpit](https://github.com/creatorofuniverses/cockpit)
  (`remote-desk-two-way`, merged through its `main`, without its `aq` panel): every app action goes to the runner
  through herdr-core's machine connection, and a runner's window calls (`show` panes, blueprints, Documents,
  `herdr-app ls/status`) are relayed to the desk over the hub's authenticated window channel.
- **`"window": "desk"`** in a runner's `~/.config/cockpit/config.json`: window calls go to the desk even where the
  runner has a Herdr app installed (otherwise a local `herdr-app` wins and `show` panes open on the runner's screen).
- **`"hubListen": "<ip>"`** in a runner's config: its hub listens there whoever starts it (a session, a window, after
  an idle exit). Upstream's `COCKPIT_HUB_LISTEN=<ip> cockpit hub start` never reached the hub in 1.2.0, whose
  environment is the login shell's; the fork keeps that variable too.
- **`"hubForward": "<ip>"`** (with `"hubPort"`, default 47821) in a runner's config: the hub listens on loopback at
  that port, hub.json gives desks `<ip>`, and `tailscale serve --tcp` forwards it. macOS's firewall holds incoming
  connections for cockpit's ad-hoc-signed binary until someone approves it on the runner's screen, again after every
  update; loopback and Tailscale's own process are past it. `scripts/desk.sh runner` sets this up.
- **Notifications reach the desk.** Behind other windows, a remote desk posts a runner's notification as a system
  notification on the desk (the Cockpit notifier on macOS, `notify-send` on Linux), and a click on it
  (`cockpit focus herdr-app:<row>`) is handed to the desk's mod.
- **Several hubs in one window** (upstream #51, `docs/app.md`, "Several hubs in one window"): `cockpit.json`'s `extra`
  lists this machine's cockpit and other runners (`desk.sh desk <runner> --with-local --local-name <name> --runner <other>`). Every hub's
  agents in one list, each acted on at its own hub; the apps behind a machine switch in the sidebar
  (`cockpit.hub:<name>`); each session's `show` panes from its own hub; notifications, window commands and usage
  limits from every hub.
- **`cockpit app install` keeps a remote desk's `cockpit.json`**, so updates no longer turn the desk back into a local
  install.
- Install, update and release links point at this fork; its releases are its own.
- `scripts/desk.sh` sets both ends up (`build`, `runner`, `desk <machine>`).

## Setting it up

On the runner (here `studio`) and the desk, from a checkout of this fork:

```sh
sh scripts/desk.sh build              # both machines, until the fork publishes releases
sh scripts/desk.sh runner             # on the runner: window = desk, hub on its Tailscale IP
sh scripts/desk.sh desk studio --with-local   # on the desk: the mod, cockpit.json on studio's hub and this machine's
                                              # (--runner <other> adds another runner)
```

Sessions on the runner need this fork's Claude Code plugin (its hooks relay `show`):
`/plugin marketplace remove cockpit`, then `/plugin install cockpit --marketplace LucasCoderT/cockpit`.

## Planned

- The side browser reaching a runner's dev server.

## Keeping up with upstream

```sh
git fetch upstream && git merge upstream/main
```

Then bump past upstream's version (`sh scripts/cut-release.sh patch`) so installs take the fork's build.
