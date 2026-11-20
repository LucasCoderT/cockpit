// The other hubs a window follows besides its own (cockpit.json's `extra`, upstream #51): this machine's cockpit when
// the window reads a runner's hub, and other runners. Every hub here is one install, `{name, bin, home, cache}` for this
// machine's, plus `machine` and `host` for a runner's, read the way a remote desk reads its own:
//
//   "extra": [{"name": "laptop", "bin": "/Users/me/.config/cockpit/herdr/bin/cockpit", "home": "/Users/me",
//              "cache": "/Users/me/.cache/cockpit"},
//             {"name": "box", "machine": "box", "host": "100.64.0.20", "bin": "/home/me/.local/bin/cockpit",
//              "home": "/home/me", "cache": "/home/me/.cache/cockpit"}]
//
// - Agents: every hub's join the agents view (`fleet.rowsOf`), each at its own address; an action on one goes to its hub.
// - Apps (inbox, to-do, runbook, meetings, mail, monitor, routines, Home's PRs): one hub at a time, the machine the
//   window picked (`pick`, the sidebar's machine switch); their actions go there too.
// - A session's own views (`show`): the hub of the machine its pane or terminal is on (`targetForMachine`).
// - Notifications and a runner's window commands: from every hub, on the subscription that asks for them (the sidebar).
//
// Each hub is followed on connections of its own, outside the main hub's watchdog.

import { exec, readTextFile, run, panes, shared, setShared } from "herdr";

// hub.js's own helpers, handed over when it loads (it imports this module, so this one cannot import it back).
let deps = {};
export function configure(given) {
  deps = given;
}

/** The followers' freshness: a follower silent this long is started again by a subscriber's beat. */
export const FOLLOWER_STALE_MS = 15_000;
const KEEPALIVE_SECS = 30;
const START_EVERY_MS = 30_000;
/** Where the window keeps the machine its apps read (shared, so every copy and a restart see it). */
export const PICK_KEY = "cockpit.hub";
/** The views and documents that follow the picked machine, and the apps whose actions do. */
export const APP_VIEWS = new Set(["inbox", "todo", "runbook", "meetings", "mail", "monitor", "routines", "home", "routines-when", "monitor-window"]);
export const APP_ACTS = new Set(["inbox", "todo", "runbook", "meetings", "mail", "monitor", "routines", "home"]);

const state = () => (globalThis.cockpitExtraHubs ??= { followers: new Map(), version: 0, list: null });

/** Each handle an extra hub's rows carry → {name, request}: what `hub.request` routes an agents action by. */
export const owners = () => (globalThis.cockpitExtraOwners ??= new Map());

/** The extra installs a cockpit.json lists, each with a name; a runner's needs its machine and host. */
export function extrasOf(value) {
  const list = value?.extra;
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === "object" && typeof e.cache === "string" && e.cache && (!e.machine || (typeof e.host === "string" && e.host)))
    .map((e, i) => ({ ...e, name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.machine ?? `hub-${i + 1}` }));
}

/** The extra installs now (cockpit.json read again every few seconds), remembered for the calls that cannot wait. */
export async function extras() {
  const list = extrasOf(await deps.install());
  state().list = list;
  return list;
}

/** The extras as last read: what a subscription is split by when it opens, before any read comes back. */
export const extrasNow = () => state().list ?? [];

/** The machine the window's apps read: an extra's name, or null for the window's own hub. */
export function picked(list = extrasNow()) {
  const p = shared(PICK_KEY);
  return typeof p === "string" && list.some((e) => e.name === p) ? p : null;
}

/** Picks the machine the apps read (null: the window's own hub). */
export function pick(name) {
  setShared(PICK_KEY, name ?? null);
}

const byName = (name) => extrasNow().find((e) => e.name === name) ?? null;

/**
 * The hub a machine's terminals and panes belong to: null for the window's own, else an extra's name. `primary` is the
 * window's install; a machine null is this one.
 */
export function targetForMachine(machine, primary, list = extrasNow()) {
  const m = machine ?? null;
  if (m === (primary?.machine ?? null)) return null;
  return list.find((e) => (e.machine ?? null) === m)?.name ?? null;
}

/** The hub of a terminal at a desk address (`t5` here, `box/t7` on a runner). */
export function targetForAddress(address, primary, list = extrasNow()) {
  const a = String(address ?? "").replace(/^app:/, "");
  const at = a.indexOf("/");
  return targetForMachine(at > 0 ? a.slice(0, at) : null, primary, list);
}

/** Where a request goes: the hub named (`hub`), the hub that lists the agent acted on, the picked machine for an app. */
export async function targetOf(op, fields, named) {
  if (named !== undefined) return named && byName(named) ? named : named ? missing(named) : null;
  const list = extrasNow().length ? extrasNow() : await extras().catch(() => []);
  const p = picked(list);
  if (!p) return null;
  if (op === "act" && APP_ACTS.has(fields.app)) return p;
  if (op === "view" && APP_VIEWS.has(fields.name)) return p;
  if (op === "events" && APP_ACTS.has(fields.app)) return p;
  return null;
}

function missing(name) {
  throw new Error(`no hub named ${name} in cockpit.json`);
}

async function readInfo(inst, cx) {
  const text = await deps.within(cx, readTextFile(`${inst.cache}/hub.json`, inst.machine ? { on: inst.machine } : undefined), 10_000, `${inst.name}'s hub.json`);
  return text ? JSON.parse(text) : null;
}

/** Starts a hub of this machine's (never a runner's), at most every 30 s. */
async function startLocal(inst, mark) {
  if (inst.machine || !inst.bin || Date.now() - (mark.started ?? 0) < START_EVERY_MS) return;
  mark.started = Date.now();
  await exec("env", [`HOME=${inst.home ?? ""}`, "COCKPIT_FRONTEND=app", inst.bin, "hub", "start"]).catch(() => null);
}

async function connect(inst, cx) {
  const info = await readInfo(inst, cx);
  if (!info?.port || !info?.token) throw new Error(`${inst.name}'s cockpit hub is not running`);
  const host = inst.machine ? inst.host : info.host ?? "127.0.0.1";
  const socket = await deps.within(cx, deps.net.connect(host, info.port), 10_000, `${inst.name}'s cockpit hub`);
  return { socket, token: info.token, lines: new deps.Lines(socket, cx?.timer ? () => deps.sleep(cx, 50) : null) };
}

const close = (socket) => {
  try {
    socket?.close?.();
  } catch {
    // Already gone.
  }
};

/** One line asked of a hub over TCP: its answer, or a thrown Error with the hub's `error`. */
async function ask(inst, line, cx) {
  const { socket, token, lines } = await connect(inst, cx);
  try {
    await socket.write(JSON.stringify({ token, frontend: "app", ...line }) + "\n");
    for (;;) {
      const got = await deps.within(cx, lines.next(), 60_000, `${inst.name}'s cockpit hub`);
      if (got === null) throw new Error(`${inst.name}'s cockpit hub closed the connection`);
      if (!got.trim()) continue;
      const answer = JSON.parse(got);
      if (answer.error) throw new Error(answer.error);
      return answer;
    }
  } finally {
    close(socket);
  }
}

/**
 * One request to an extra hub, by name. This machine's hub takes it over TCP; a runner's reads over TCP and acts
 * through herdr-core (its TCP side reads only), and its navigation stays in this window.
 */
export async function requestAt(name, op, fields = {}, cx = null) {
  const inst = byName(name) ?? (await extras()).find((e) => e.name === name);
  if (!inst) missing(name);
  if (inst.machine) {
    if (op === "go") return deps.focusHere(fields.target);
    if (op === "act") return deps.runnerAct(inst, fields);
    if (!deps.reads?.has(op)) throw new Error(`${op} is not something ${inst.name}'s hub takes from this window`);
  }
  return ask(inst, { op, ...fields }, cx);
}

/** The rows of an extra hub's agents view: its own terminals, at their desk addresses, each handle routed back to it. */
export function adopt(inst, value) {
  // A hub sees every machine its window shows: only its own terminals (bare addresses) are its to add.
  const own = (r) => !String(r.address ?? r.terminal ?? "").replace(/^app:/, "").includes("/");
  const rows = (Array.isArray(value?.agents) ? value.agents : []).filter(own).map((r) => {
    if (!inst.machine) return { ...r, hub: inst.name };
    const address = `${inst.machine}/${String(r.address ?? "").replace(/^app:/, "")}`;
    return { ...r, hub: inst.name, remote: inst.machine, address, terminal: `app:${address}` };
  });
  for (const [handle, owner] of owners()) if (owner.name === inst.name) owners().delete(handle);
  const route = { name: inst.name, request: (op, fields, cx) => requestAt(inst.name, op, fields, cx) };
  for (const r of rows) if (typeof r.terminal === "string") owners().set(r.terminal, route);
  // Its own counts take in the other machines' rows too: these are counted from the rows it adds.
  const counts = { total: rows.length, unread: rows.filter((r) => r.unread).length };
  for (const r of rows) if (typeof r.stage === "string") counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  const quota = (Array.isArray(value?.quota) ? value.quota : []).map((q) => ({ ...q, machine: inst.name }));
  return { rows, counts, quota };
}

/** What the extra hubs' agents say now, for the agents view: [{name, rows, counts, quota}], and a version that moves. */
export function current() {
  const s = state();
  return { version: s.version, extra: [...s.followers.values()].filter((f) => f.value).map((f) => ({ name: f.name, rows: f.value.rows, counts: f.value.counts, quota: f.value.quota })) };
}

/**
 * Follows one hub for as long as `wanted()` says: subscribes to `opts` (views, docs, notify, window), hands each line to
 * `onMessage`, says "connecting", "live" or "error: …" to `onState`, and reconnects with backoff. A runner's window
 * commands are run in this window, as a remote desk runs its own runner's.
 */
function followAt(inst, cx, opts, onMessage, onState, wanted) {
  const mark = { alive: Date.now() };
  cx.spawn(async (cx) => {
    let wait = 500;
    while (wanted()) {
      mark.alive = Date.now();
      let own = null;
      try {
        onState("connecting", cx);
        const c = await connect(inst, cx).catch(async (e) => {
          await startLocal(inst, mark);
          throw e;
        });
        own = c.socket;
        let secret = null;
        if (opts.window && inst.machine) {
          const r = await deps.cockpitOn(inst, ["hub", "window-token"]);
          if (r.code !== 0) throw new Error(r.stderr?.trim() || `could not get ${inst.name}'s window secret`);
          secret = JSON.parse(r.stdout).secret;
        }
        await own.write(JSON.stringify({ op: "subscribe", token: c.token, views: opts.views ?? [], docs: opts.docs ?? [], notify: Boolean(opts.notify), keepalive: KEEPALIVE_SECS, ...(secret ? { window: true, window_secret: secret } : {}) }) + "\n");
        let wrote = Date.now();
        wait = 500;
        onState("live", cx);
        while (wanted()) {
          const line = await deps.within(cx, c.lines.next(), 65_000, `${inst.name}'s cockpit hub`);
          if (line === null) break;
          mark.alive = Date.now();
          if (Date.now() - wrote >= (KEEPALIVE_SECS - 5) * 1000) {
            await own.write("\n");
            wrote = Date.now();
          }
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(message.error);
          if (message.window && secret) {
            const outcome = await deps.runWindowCommand(message.window, { machine: inst.machine, run, clipboard: deps.desktopClipboard(cx), focus: deps.focusHere, panes, herdrApp: deps.herdrApp });
            await ask(inst, { op: "window_reply", id: message.window.id, secret, capability: message.window.capability, ...outcome }, cx).catch(() => {});
            continue;
          }
          // A runner's focus requests are its own window's business; this one navigates by itself.
          if (inst.machine && message.focus) continue;
          onMessage({ ...message, hub: inst }, cx);
        }
      } catch (e) {
        if (wanted()) onState(`error: ${e?.message ?? e}`, cx);
      } finally {
        close(own);
      }
      if (!wanted()) break;
      await deps.sleep(cx, wait);
      wait = Math.min(wait * 2, 10_000);
    }
  });
  return mark;
}

/** Keeps a window-wide follower of every extra hub's agents (one each, started again when the one following went quiet). */
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
    const f = s.followers.get(inst.name) ?? { name: inst.name, value: null, run: 0 };
    s.followers.set(inst.name, f);
    f.wanted = Date.now();
    if (f.mark && Date.now() - (f.mark.alive ?? 0) <= FOLLOWER_STALE_MS) continue;
    const run = ++f.run;
    const live = () => f.run === run && Date.now() - f.wanted < FOLLOWER_STALE_MS * 2;
    f.mark = followAt(inst, cx, { views: [{ name: "agents", args: { frontend: "app" } }] }, (m) => {
      if (m.view !== "agents") return;
      f.value = adopt(inst, m.value);
      s.version += 1;
    }, (st) => {
      if (st.startsWith("error") && f.value) {
        f.value = null;
        s.version += 1;
      }
    }, live);
  }
}

/** How far apart two readings' resets can be and still be one window of one account (clocks, rounding). */
const SAME_WINDOW_MS = 10 * 60 * 1000;

/**
 * Every hub's usage limits in one list. A subscription's limits are its account's, not a machine's: two readings of the
 * same agent's window whose resets agree (or that cannot say) are one account, shown once by its freshest reading; one
 * whose window resets at another time is another account, named after its machine ("7d · laptop").
 */
export function mergeQuota(own = [], extra = []) {
  const list = Array.isArray(own) ? [...own] : [];
  const kind = (q) => `${q.agent ?? ""}|${q.provider ?? ""}|${q.name ?? ""}`;
  const sameAccount = (a, b) => kind(a) === kind(b) && (a.resets_at == null || b.resets_at == null || Math.abs(a.resets_at - b.resets_at) <= SAME_WINDOW_MS);
  const fresher = (a, b) => ((b.state === "fresh") !== (a.state === "fresh") ? b.state === "fresh" : (b.as_of ?? 0) > (a.as_of ?? 0));
  for (const q of extra.flatMap((e) => e.quota ?? [])) {
    const at = list.findIndex((p) => sameAccount(p, q));
    if (at >= 0) {
      // The same account read on another machine: its newer reading wins, under the account's own name.
      if (fresher(list[at], q)) list[at] = { ...q, name: list[at].name, label: list[at].label };
      continue;
    }
    const named = list.some((p) => kind(p) === kind(q));
    list.push(named ? { ...q, name: `${q.name} · ${q.machine}`, label: `${q.label ?? q.name} · ${q.machine}` } : q);
  }
  return list;
}

/** Whether a subscription reads the agents view. */
export const readsAgents = (views = []) => views.some((v) => nameOf(v) === "agents");
const nameOf = (v) => (typeof v === "string" ? v : v?.name);

/** A subscription's views and documents, split by the hub each one is read from: {primary, picked}. */
export function split(opts, p = picked()) {
  if (!p) return { primary: opts, picked: null };
  const views = opts.views ?? [];
  const docs = opts.docs ?? [];
  const away = { views: views.filter((v) => APP_VIEWS.has(nameOf(v))), docs: docs.filter((d) => APP_VIEWS.has(d)) };
  if (!away.views.length && !away.docs.length) return { primary: opts, picked: null };
  const primary = { ...opts, views: views.filter((v) => !APP_VIEWS.has(nameOf(v))), docs: docs.filter((d) => !APP_VIEWS.has(d)) };
  return { primary, picked: { name: p, ...away } };
}

/**
 * hub.js's `subscribe` across every hub: `open` is its own (the window's hub). A subscription naming `hub` reads that
 * hub alone (null: the window's). Otherwise the apps' views follow the picked machine, the agents view carries every
 * extra hub's rows (sent again on the copy's timer when they move), and notifications and window commands come from
 * every hub. Messages from another hub carry it as `hub`.
 */
export function route(open, cx, opts, onMessage, onState = () => {}) {
  if (opts?.hub !== undefined) {
    const { hub: name, ...rest } = opts;
    if (!name) return open(cx, rest, onMessage, onState);
    return single(cx, name, rest, onMessage, onState);
  }
  // cockpit.json known to list no other hub: hub.js's own subscription, as it always was.
  if (state().list !== null && !extrasNow().length && !readsAgents(opts?.views) && !opts?.notify && !opts?.window) {
    return open(cx, opts, onMessage, onState);
  }
  const agents = readsAgents(opts?.views);
  const everywhere = Boolean(opts?.notify || opts?.window);
  let parts = null;
  let last = null;
  let sent = -1;
  let primaryState = "connecting";
  let pickedState = null;
  const say = (cx) => onState(pickedState ?? primaryState, cx);
  const emit = (cx) => {
    if (!last) return;
    const now = current();
    sent = now.version;
    if (!now.extra.length) return onMessage(last, cx);
    onMessage({ ...last, value: { ...last.value, extra: now.extra, quota: mergeQuota(last.value?.quota, now.extra) } }, cx);
  };
  const deliver = (m, cx) => {
    if (agents && m.view === "agents" && !m.hub) {
      last = m;
      return emit(cx);
    }
    onMessage(m, cx);
  };
  const stampOf = (list) => `${picked(list) ?? ""}|${list.map((e) => e.name).join(",")}`;
  const openParts = (cx) => {
    const list = extrasNow();
    const stamp = stampOf(list);
    const { primary, picked: away } = split(opts, picked(list));
    const mine = { stamp, stopped: false, subs: [] };
    parts = mine;
    const wanted = () => parts === mine && !mine.stopped;
    pickedState = away ? "connecting" : null;
    const hasPrimary = (primary.views?.length ?? 0) + (primary.docs?.length ?? 0) > 0 || primary.notify || primary.window || primary.focus;
    if (hasPrimary) mine.subs.push(open(cx, primary, deliver, (st, cx) => ((primaryState = st), say(cx))));
    if (away) {
      const inst = list.find((e) => e.name === away.name);
      // The view a pending navigation waits for (a notification's row) comes from the picked machine: it is handled here.
      const app = opts.focus && away.views.some((v) => nameOf(v) === opts.focus) ? opts.focus : null;
      const ready = new Set();
      const navigation = (globalThis.cockpitRemoteFocus ??= { targets: new Map(), listeners: new Set() });
      const focused = (target) => {
        if (!wanted() || target?.app !== app || !ready.has(app)) return false;
        navigation.targets.delete(app);
        onMessage({ focus: app, target }, cx);
        return true;
      };
      focused.load = deps.load;
      if (app) {
        navigation.listeners.add(focused);
        mine.unlisten = () => navigation.listeners.delete(focused);
      }
      const arrive = (m, cx) => {
        deliver(m, cx);
        if (app && m.view === app && !ready.has(app)) {
          ready.add(app);
          const target = navigation.targets.get(app);
          if (target) focused(target);
        }
      };
      followAt(inst, cx, { views: away.views, docs: away.docs }, arrive, (st, cx) => ((pickedState = st), say(cx)), wanted);
    }
    if (everywhere) {
      for (const inst of list) followAt(inst, cx, { notify: Boolean(opts.notify), window: Boolean(opts.window) && Boolean(inst.machine) }, (m, cx) => m.notify && onMessage(m, cx), () => {}, wanted);
    }
  };
  const closeParts = () => {
    if (!parts) return;
    parts.stopped = true;
    parts.unlisten?.();
    for (const sub of parts.subs) sub.stop();
  };
  openParts(cx);
  let checked = 0;
  let stopped = false;
  const timer = typeof cx?.timer?.every === "function"
    ? cx.timer.every(1000, (cx) => {
        if (stopped) return;
        if (Date.now() - checked > 3000) {
          checked = Date.now();
          cx.spawn(async (cx) => {
            await extras().catch(() => []);
            if (agents) await keep(cx);
          });
        }
        // The picked machine or the extras changed: the subscription is split again.
        if (parts && parts.stamp !== stampOf(extrasNow())) {
          closeParts();
          openParts(cx);
        }
        if (agents && current().version !== sent) emit(cx);
      })
    : null;
  return {
    get stopped() {
      return stopped || (parts?.subs[0]?.stopped ?? false);
    },
    stop() {
      stopped = true;
      timer?.cancel?.();
      closeParts();
    },
  };
}

/** A subscription to one extra hub alone, with the same stop() as hub.js's. */
function single(cx, name, opts, onMessage, onState) {
  let stopped = false;
  const inst = byName(name);
  if (!inst) {
    onState(`error: no hub named ${name} in cockpit.json`, cx);
    return { stopped: false, stop() {} };
  }
  followAt(inst, cx, opts, onMessage, onState, () => !stopped);
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
  };
}
