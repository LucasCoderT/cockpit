// The other hubs a desk follows besides its own (cockpit.json's `extra`): this machine's cockpit when the window reads a
// runner's hub, or another runner's. Each is followed for its agents alone, on a connection of its own, outside the
// main hub's watchdog: their rows join the agents view (`fleet.rowsOf`), and an action on one of them goes back to its
// hub (`hub.request` finds it in `owners()`).
//
//   "extra": [{"name": "laptop", "bin": "/Users/me/.config/cockpit/herdr/bin/cockpit", "home": "/Users/me",
//              "cache": "/Users/me/.cache/cockpit"}]
//
// An entry with `machine` and `host` is another runner, read the way a remote desk reads its own.

import net from "net";
import { exec, readTextFile } from "herdr";

// hub.js's own helpers, handed over when it loads (it imports this module, so this one cannot import it back).
let install, Lines, sleep, within;
export function configure(deps) {
  ({ install, Lines, sleep, within } = deps);
}

/** How long a follower may go without a step before a subscriber's beat starts another. */
export const FOLLOWER_STALE_MS = 15_000;
const KEEPALIVE_SECS = 30;
const START_EVERY_MS = 30_000;

const state = () => (globalThis.cockpitExtraHubs ??= { followers: new Map(), version: 0 });

/** Each handle an extra hub's rows carry → {name, request}: what `hub.request` routes an agents action by. */
export const owners = () => (globalThis.cockpitExtraOwners ??= new Map());

/** The extra installs cockpit.json lists, each with a name. */
export async function extras() {
  const list = (await install())?.extra;
  if (!Array.isArray(list)) return [];
  // This machine's cockpit only, for now: another runner's would need its actions sent through herdr-core.
  return list
    .filter((e) => e && typeof e === "object" && typeof e.cache === "string" && e.cache && !e.machine)
    .map((e, i) => ({ ...e, name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.machine ?? `hub-${i + 1}` }));
}

/** What the extra hubs say now, for the agents view: [{name, rows, counts}], and a version that moves with it. */
export function current() {
  const s = state();
  return { version: s.version, extra: [...s.followers.values()].filter((f) => f.value).map((f) => ({ name: f.name, rows: f.value.rows, counts: f.value.counts })) };
}

async function readInfo(inst, cx) {
  const text = await within(cx, readTextFile(`${inst.cache}/hub.json`, inst.machine ? { on: inst.machine } : undefined), 10_000, `${inst.name}'s hub.json`);
  return text ? JSON.parse(text) : null;
}

/** Starts a hub of this machine's (never a runner's), at most every 30 s. */
async function startLocal(inst, follower) {
  if (inst.machine || !inst.bin || Date.now() - (follower.started ?? 0) < START_EVERY_MS) return;
  follower.started = Date.now();
  await exec("env", [`HOME=${inst.home ?? ""}`, "COCKPIT_FRONTEND=app", inst.bin, "hub", "start"]).catch(() => null);
}

async function connect(inst, cx) {
  const info = await readInfo(inst, cx);
  if (!info?.port || !info?.token) throw new Error(`${inst.name}'s cockpit hub is not running`);
  const host = inst.machine ? inst.host : info.host ?? "127.0.0.1";
  const socket = await within(cx, net.connect(host, info.port), 10_000, `${inst.name}'s cockpit hub`);
  return { socket, token: info.token, lines: new Lines(socket, cx?.timer ? () => sleep(cx, 50) : null) };
}

const close = (socket) => {
  try {
    socket?.close?.();
  } catch {
    // Already gone.
  }
};

/** One request to an extra hub: its answer, or a thrown Error with the hub's `error`. */
export async function request(inst, op, fields = {}, cx = null) {
  const { socket, token, lines } = await connect(inst, cx);
  try {
    await socket.write(JSON.stringify({ op, token, frontend: "app", ...fields }) + "\n");
    for (;;) {
      const line = await within(cx, lines.next(), 60_000, `${inst.name}'s cockpit hub`);
      if (line === null) throw new Error(`${inst.name}'s cockpit hub closed the connection`);
      if (!line.trim()) continue;
      const answer = JSON.parse(line);
      if (answer.error) throw new Error(answer.error);
      return answer;
    }
  } finally {
    close(socket);
  }
}

/** The rows of an extra hub's agents view, each told apart by `hub` and its handle registered for routing. */
export function adopt(inst, value) {
  // This machine's hub sees every machine the window shows: only its own terminals (bare addresses) are its to add.
  const own = (r) => !String(r.address ?? r.terminal ?? "").replace(/^app:/, "").includes("/");
  const rows = (Array.isArray(value?.agents) ? value.agents : []).filter(own).map((r) => ({ ...r, hub: inst.name }));
  for (const [handle, owner] of owners()) if (owner.name === inst.name) owners().delete(handle);
  const route = { name: inst.name, request: (op, fields, cx) => request(inst, op, fields, cx) };
  for (const r of rows) if (typeof r.terminal === "string") owners().set(r.terminal, route);
  // Its own counts take in the other machines' rows too: these are counted from the rows it adds.
  const counts = { total: rows.length, unread: rows.filter((r) => r.unread).length };
  for (const r of rows) if (typeof r.stage === "string") counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  return { rows, counts };
}

/** Follows one extra hub's agents for as long as subscribers beat; reconnects with backoff. */
function follow(inst, cx) {
  const s = state();
  const follower = s.followers.get(inst.name) ?? { name: inst.name, value: null };
  follower.alive = Date.now();
  follower.run = (follower.run ?? 0) + 1;
  const run = follower.run;
  s.followers.set(inst.name, follower);
  const mine = () => follower.run === run && Date.now() - (follower.wanted ?? 0) < FOLLOWER_STALE_MS * 2;
  cx.spawn(async (cx) => {
    let wait = 500;
    while (mine()) {
      follower.alive = Date.now();
      let own = null;
      try {
        const c = await connect(inst, cx).catch(async (e) => {
          await startLocal(inst, follower);
          throw e;
        });
        own = c.socket;
        await own.write(JSON.stringify({ op: "subscribe", token: c.token, views: [{ name: "agents", args: { frontend: "app" } }], keepalive: KEEPALIVE_SECS }) + "\n");
        let wrote = Date.now();
        wait = 500;
        while (mine()) {
          const line = await within(cx, c.lines.next(), 65_000, `${inst.name}'s cockpit hub`);
          if (line === null) break;
          follower.alive = Date.now();
          if (Date.now() - wrote >= (KEEPALIVE_SECS - 5) * 1000) {
            await own.write("\n");
            wrote = Date.now();
          }
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(message.error);
          if (message.view === "agents") {
            follower.value = adopt(inst, message.value);
            s.version += 1;
          }
        }
      } catch {
        // Down or unreachable: its rows stay out until it answers again.
        if (follower.value) {
          follower.value = null;
          s.version += 1;
        }
      } finally {
        close(own);
      }
      if (!mine()) break;
      await sleep(cx, wait);
      wait = Math.min(wait * 2, 10_000);
    }
  });
}

/**
 * Called on each beat of a subscription that reads the agents view: keeps a follower going for every extra hub (one
 * per window, started again on this copy's context when the one following it went quiet).
 */
export async function keep(cx) {
  const s = state();
  const list = await extras().catch(() => []);
  const names = new Set(list.map((e) => e.name));
  for (const [name, f] of s.followers) {
    if (!names.has(name)) {
      f.run += 1;
      s.followers.delete(name);
      if (f.value) s.version += 1;
    }
  }
  for (const inst of list) {
    const f = s.followers.get(inst.name);
    if (f) f.wanted = Date.now();
    if (!f || Date.now() - (f.alive ?? 0) > FOLLOWER_STALE_MS) {
      follow(inst, cx);
      s.followers.get(inst.name).wanted = Date.now();
    }
  }
}

/** Whether a subscription reads the agents view. */
export const readsAgents = (views = []) => views.some((v) => (typeof v === "string" ? v : v?.name) === "agents");

/**
 * A subscription `open` makes (hub.js's own), its agents view carrying `extra`: what the extra hubs say, sent again on
 * the copy's own timer whenever it moves. Other views pass through as they come.
 */
export function withExtras(open, cx, opts, onMessage, onState) {
  let last = null;
  let sent = -1;
  const emit = (cx) => {
    if (!last) return;
    const now = current();
    sent = now.version;
    onMessage(now.extra.length ? { ...last, value: { ...last.value, extra: now.extra } } : last, cx);
  };
  const sub = open(cx, opts, (m, cx) => {
    if (m.view === "agents") {
      last = m;
      emit(cx);
    } else onMessage(m, cx);
  }, onState);
  let checked = 0;
  const timer = typeof cx?.timer?.every === "function"
    ? cx.timer.every(1000, (cx) => {
        if (sub.stopped) return;
        // cockpit.json is read again every few seconds; the followers' own news is cheap to look at every second.
        if (Date.now() - checked > 3000) {
          checked = Date.now();
          cx.spawn(async (cx) => keep(cx));
        }
        if (current().version !== sent) emit(cx);
      })
    : null;
  return {
    get stopped() {
      return sub.stopped;
    },
    stop() {
      timer?.cancel?.();
      sub.stop();
    },
  };
}
