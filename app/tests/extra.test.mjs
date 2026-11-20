import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// extra.js alone: herdr and net stubbed, hub.js's helpers handed over as hub.js does.
async function load() {
  const context = createContext({ console });
  const stubs = {
    herdr: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => null, run: () => {}, panes: () => [], shared: () => null, setShared: () => {} },
  };
  const module = new SourceTextModule(await readFile(new URL("../mods/cockpit/extra.js", import.meta.url), "utf8"), { context });
  await module.link((name) => new SyntheticModule(Object.keys(stubs[name]), function () {
    for (const [k, v] of Object.entries(stubs[name])) this.setExport(k, v);
  }, { context }));
  await module.evaluate();
  const extra = module.namespace;
  extra.configure({ net: { connect: async () => { throw new Error("no network in this test"); } }, install: async () => ({ extra: [] }), Lines: class {}, sleep: async () => {}, within: (_cx, p) => p });
  return { extra, context };
}

/** A copy's context whose timer runs its callbacks when the test says so. */
function copy() {
  const ticks = [];
  const cx = { timer: { every: (_ms, fn) => (ticks.push(fn), { cancel: () => ticks.splice(ticks.indexOf(fn), 1) }) }, spawn: () => {} };
  return { cx, tick: () => ticks.forEach((fn) => fn(cx)) };
}

test("an extra hub's rows are told apart and their handles route back to it", async () => {
  const { extra } = await load();
  // This machine's hub also sees the runner's terminals the window shows: only its own bare addresses are added.
  const adopted = extra.adopt({ name: "laptop", cache: "/c" }, { agents: [{ terminal: "app:t5", address: "t5" }, { terminal: "app:studio/t4", address: "studio/t4", stage: "working" }], counts: { working: 1, total: 2 } });
  assert.deepEqual(JSON.parse(JSON.stringify(adopted)), { rows: [{ terminal: "app:t5", address: "t5", hub: "laptop" }], counts: { total: 1, unread: 0 }, quota: [] });
  assert.equal(extra.owners().get("app:t5").name, "laptop");
  // A later view without that agent takes its handle away.
  extra.adopt({ name: "laptop", cache: "/c" }, { agents: [] });
  assert.equal(extra.owners().has("app:t5"), false);
});

test("the agents view carries the extra hubs' rows, sent again on the copy's timer when they move", async () => {
  const { extra, context } = await load();
  assert.equal(extra.readsAgents(["home", { name: "agents", args: { frontend: "app" } }]), true);
  assert.equal(extra.readsAgents(["inbox"]), false);
  let deliver;
  let opened = null;
  const open = (_cx, opts, onMessage) => ((deliver = onMessage), (opened = { opts, stopped: false, stop() { this.stopped = true; } }));
  const got = [];
  const { cx, tick } = copy();
  const sub = extra.route(open, cx, { views: ["agents", "home"] }, (m) => got.push(m), () => {});
  deliver({ view: "agents", value: { agents: [{ address: "t7" }], quota: [{ provider: "Claude", name: "7d", percent: 87, resets_at: 1e12 }] } }, cx);
  deliver({ view: "home", value: { merged: [] } }, cx);
  assert.deepEqual(JSON.parse(JSON.stringify(got.map((m) => [m.view, m.value.extra ?? null]))), [["agents", null], ["home", null]]);
  // A follower's news: the laptop's agents arrive, with its limits labelled by machine.
  context.cockpitExtraHubs.followers.set("laptop", { name: "laptop", value: { rows: [{ address: "t5", hub: "laptop" }], counts: {}, quota: [{ provider: "Claude", name: "7d", percent: 40, resets_at: 9e12, machine: "laptop" }] }, mark: { alive: Date.now() } });
  context.cockpitExtraHubs.version += 1;
  tick();
  assert.equal(got.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(got[2].value.extra.map((e) => [e.name, e.rows.length]))), [["laptop", 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(got[2].value.quota.map((q) => [q.name, q.machine ?? null]))), [["7d", null], ["7d · laptop", "laptop"]]);
  tick();
  assert.equal(got.length, 3, "nothing moved: nothing sent again");
  sub.stop();
  assert.equal(opened.stopped, true);
});

test("the apps follow the picked machine while the agents and the rest stay on the window's hub", async () => {
  const { extra } = await load();
  const opts = { views: [{ name: "inbox", args: { group: "all" } }, { name: "agents", args: {} }], docs: ["todo", "agents"], focus: "inbox" };
  assert.deepEqual(JSON.parse(JSON.stringify(extra.split(opts, null))), { primary: opts, picked: null });
  const { primary, picked } = extra.split(opts, "laptop");
  assert.deepEqual(JSON.parse(JSON.stringify(primary)), { views: [{ name: "agents", args: {} }], docs: ["agents"], focus: "inbox" });
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), { name: "laptop", views: [{ name: "inbox", args: { group: "all" } }], docs: ["todo"] });
});

test("a terminal or a pane belongs to the hub of its machine", async () => {
  const { extra } = await load();
  const list = [{ name: "laptop", cache: "/c" }, { name: "box", machine: "box", host: "100.64.0.20", cache: "/b" }];
  const desk = { machine: "studio" };
  assert.equal(extra.targetForAddress("studio/t4", desk, list), null);
  assert.equal(extra.targetForAddress("app:t5", desk, list), "laptop");
  assert.equal(extra.targetForAddress("box/t2", desk, list), "box");
  assert.equal(extra.targetForMachine(null, {}, list), null, "a window on this machine's own hub");
  assert.deepEqual(JSON.parse(JSON.stringify(extra.extrasOf({ extra: [{ cache: "/c" }, { machine: "box", cache: "/b" }, { name: "x" }] }).map((e) => e.name))), ["hub-1"], "a runner needs a host, every hub a cache");
  const rows = extra.adopt(list[1], { agents: [{ terminal: "app:t2", address: "t2", stage: "needs_you", unread: true }] }).rows;
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => [r.address, r.terminal, r.remote, r.hub]))), [["box/t2", "app:box/t2", "box", "box"]]);
  assert.equal(extra.owners().get("app:box/t2").name, "box");
});

test("a subscription's limits show once, by the freshest reading; another account's under its machine", async () => {
  const { extra } = await load();
  const own = [{ agent: "claude", provider: "Claude", name: "7d", label: "Claude 7d", percent: 87, figure: "≥87%", state: "stale", resets_at: 1_000_000_000, as_of: 10 }];
  // The same account read on the laptop: its reset agrees within minutes, its reading is fresher.
  const laptop = [{ name: "laptop", quota: [{ agent: "claude", provider: "Claude", name: "7d", label: "Claude 7d", percent: 88, figure: "88%", state: "fresh", resets_at: 1_000_000_000 + 60_000, as_of: 20, machine: "laptop" }] }];
  const merged = extra.mergeQuota(own, laptop);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.map((q) => [q.label, q.figure]))), [["Claude 7d", "88%"]]);
  // An older reading from another machine leaves the fresher one alone.
  const older = [{ name: "laptop", quota: [{ ...laptop[0].quota[0], state: "stale", as_of: 5, figure: "≥80%" }] }];
  assert.equal(extra.mergeQuota([{ ...own[0], state: "fresh", figure: "87%" }], older)[0].figure, "87%");
  // Another account: its week resets days apart, so both show, the other under its machine; a new agent as it is.
  const box = [{ name: "box", quota: [{ agent: "claude", provider: "Claude", name: "7d", label: "Claude 7d", percent: 12, resets_at: 1_000_000_000 + 3 * 86_400_000, machine: "box" }, { agent: "codex", provider: "OpenAI", name: "5h", percent: 3, machine: "box" }] }];
  assert.deepEqual(JSON.parse(JSON.stringify(extra.mergeQuota(own, box).map((q) => q.label ?? q.name))), ["Claude 7d", "Claude 7d · box", "5h"]);
});
