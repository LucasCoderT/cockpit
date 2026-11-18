// Runs this desktop's Herdr binary with the local window home and positional arguments.
import { exec, appHome } from "herdr";

export function herdrApp(argv) {
  return exec("env", [`HERDR_APP_HOME=${appHome()}`, "sh", "-c",
    'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; exec "${HERDR_APP_BIN:-${COCKPIT_HERDR_APP_BIN:-herdr-app}}" "$@"',
    "sh", ...argv]);
}
