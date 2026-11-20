#!/bin/sh
# Sets up a remote desk: the Herdr app on this machine as the window for the agents a runner (a machine Herdr drives
# through herdr-core) runs, with this checkout's cockpit on both ends.
#
#   sh scripts/desk.sh build                    this checkout's release binary into ~/.config/cockpit/herdr/bin
#   sh scripts/desk.sh runner [--listen <ip>] [--port <n>] [--direct]
#                                               on the runner: its config says "window": "desk" (show panes, window
#                                               calls and notifications go to the desk); its hub listens on loopback at
#                                               <n> (47821) and `tailscale serve` forwards <ip>:<n> (its Tailscale IPv4)
#                                               there; --direct listens on <ip> itself instead ("hubListen")
#   sh scripts/desk.sh desk <machine> [--with-local [--local-name <name>]] [--runner <other>]...
#                                               on the desktop: this checkout's mod in the Herdr app, and cockpit.json
#                                               pointing at <machine>'s hub (its paths and address read through
#                                               herdr-core); --with-local and --runner add this machine's hub and
#                                               other runners' (app/mods/cockpit/extra.js)
#
# Run `build` on each machine first until the fork publishes releases of its own.
set -eu
cd "$(dirname "$0")/.."
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CONFIG="$HOME/.config/cockpit/config.json"
die() {
  echo "desk: $*" >&2
  exit 1
}

build() {
  (cd herdr/tui && cargo build --release --locked -p cockpit-cli)
  bin="$HOME/.config/cockpit/herdr/bin"
  [ -d "$bin" ] || die "no cockpit install at $bin: install cockpit first"
  [ -f "$bin/cockpit" ] && cp -p "$bin/cockpit" "$bin/cockpit.prev"
  cp herdr/tui/target/release/cockpit "$bin/cockpit.new"
  mv -f "$bin/cockpit.new" "$bin/cockpit"
  echo "installed $(git log --oneline -1) into $bin (the previous one is cockpit.prev)"
}

runner() {
  # Default: the hub on loopback at a fixed port, which `tailscale serve` forwards from the runner's Tailscale address:
  # the system firewall holds incoming connections for cockpit's unsigned binary, but not on loopback or Tailscale's.
  # --direct: the hub itself listens on the address, where no such firewall stands in the way.
  mode=forward listen="" port=47821
  while [ $# -gt 0 ]; do
    case "$1" in
      --direct) mode=direct ;;
      --listen) listen=${2:-} && shift ;;
      --port) port=${2:-} && shift ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [ -n "$listen" ] || listen=$(tailscale ip -4 2>/dev/null | head -1 || true)
  [ -n "$listen" ] || die "no address: pass --listen <ip> (tailscale ip -4 gave none)"
  command -v jq >/dev/null || die "jq is needed"
  [ -f "$CONFIG" ] || { mkdir -p "$(dirname "$CONFIG")" && echo '{}' >"$CONFIG"; }
  cp "$CONFIG" "$CONFIG.bak"
  if [ "$mode" = forward ]; then
    command -v tailscale >/dev/null || die "tailscale is needed to forward the hub (or pass --direct)"
    jq --arg a "$listen" --argjson p "$port" '.window = "desk" | .hubForward = $a | .hubPort = $p | del(.hubListen)' "$CONFIG.bak" >"$CONFIG"
    tailscale serve --bg --tcp "$port" "tcp://127.0.0.1:$port" >/dev/null
    echo "tailscale forwards $listen:$port to the hub on 127.0.0.1:$port"
  else
    jq --arg a "$listen" '.window = "desk" | .hubListen = $a | del(.hubForward, .hubPort)' "$CONFIG.bak" >"$CONFIG"
  fi
  echo "$CONFIG updated (the previous one is config.json.bak)"
  # Any hub started from now on takes that port, whoever starts it.
  cockpit hub stop >/dev/null 2>&1 || true
  cockpit hub start >/dev/null
  echo "hub at $(jq -r '"\(.host):\(.port)"' "$HOME/.cache/cockpit/hub.json") for desks, and on its own socket"
  echo "note: a desk's TCP connection reads only; its actions go through herdr-core"
}

# A runner's install as cockpit.json names it: its home, its cockpit binary (the link on PATH resolved) and the address
# its hub.json gives desks, read through herdr-core.
runner_install() {
  m=$1
  info=$(hc exec --on "$m" sh -lc 'echo "$HOME"; b=$(command -v cockpit); readlink -f "$b" 2>/dev/null || echo "$b"; cat "$HOME/.cache/cockpit/hub.json"') ||
    die "could not reach $m through herdr-core"
  home=$(printf '%s\n' "$info" | sed -n 1p)
  bin=$(printf '%s\n' "$info" | sed -n 2p)
  host=$(printf '%s\n' "$info" | sed -n '3,$p' | jq -r .host)
  case "$host" in "" | null | 127.* | ::1) die "the hub of $m listens on loopback only: run desk.sh runner there first" ;; esac
  jq -n --arg m "$m" --arg h "$host" --arg b "$bin" --arg home "$home" '{name: $m, machine: $m, host: $h, bin: $b, home: $home, cache: ($home + "/.cache/cockpit")}'
}

desk() {
  machine=${1:-}
  [ -n "$machine" ] || die "usage: desk.sh desk <machine> [--with-local] [--runner <machine>]..."
  shift
  command -v hc >/dev/null || die "hc (herdr-core) is needed"
  command -v jq >/dev/null || die "jq is needed"
  extra='[]'
  app_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
  # This machine's name in the window: --local-name, else the one cockpit.json gives it now, else the host's.
  local_name=$(jq -r '[.extra[]? | select(.machine == null) | .name][0] // empty' "$app_home/cockpit.json" 2>/dev/null || true)
  [ -n "$local_name" ] || local_name=$(hostname -s)
  while [ $# -gt 0 ]; do
    case "$1" in
      --local-name)
        [ -n "${2:-}" ] || die "--local-name needs a name"
        local_name=$2
        extra=$(printf '%s' "$extra" | jq --arg n "$2" 'map(if .machine == null then .name = $n else . end)')
        shift
        ;;
      --with-local)
        # This machine's own cockpit too: its agents join the runner's in the window (app/mods/cockpit/extra.js).
        local_bin=$(readlink -f "$HOME/.config/cockpit/herdr/bin/cockpit" 2>/dev/null || echo "$HOME/.config/cockpit/herdr/bin/cockpit")
        extra=$(printf '%s' "$extra" | jq --arg n "$local_name" --arg b "$local_bin" --arg home "$HOME" '. + [{name: $n, bin: $b, home: $home, cache: ($home + "/.cache/cockpit")}]')
        ;;
      --runner)
        [ -n "${2:-}" ] || die "--runner needs a machine"
        extra=$(printf '%s' "$extra" | jq --argjson r "$(runner_install "$2")" '. + [$r]')
        shift
        ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  primary=$(runner_install "$machine")
  cockpit app install --from "$PWD/app"
  printf '%s' "$primary" | jq --arg v "$(jq -r .version plugin/.claude-plugin/plugin.json)" --argjson extra "$extra" \
    'del(.name) + {version: $v} + (if ($extra | length) > 0 then {extra: $extra} else {} end)' >"$app_home/cockpit.json"
  echo "the Herdr app now reads the hub of $machine at $(printf '%s' "$primary" | jq -r .host), and $(printf '%s' "$extra" | jq length) more"
}

case "${1:-}" in
  build) build ;;
  runner)
    shift
    runner "$@"
    ;;
  desk)
    shift
    desk "$@"
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
