import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// extra.js alone: herdr and net stubbed, hub.js's helpers handed over as hub.js does.
async function load() {
  const context = createContext({ console });
  const stubs = {
    herdr: { exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => null },
    net: { default: { connect: async () => { throw new Error("no network in this test"); } } },
  };
  const module = new SourceTextModule(await readFile(new URL("../mods/cockpit/extra.js", import.meta.url), "utf8"), { context });
  await module.link((name) => new SyntheticModule(Object.keys(stubs[name]), function () {
    for (const [k, v] of Object.entries(stubs[name])) this.setExport(k, v);
  }, { context }));
  await module.evaluate();
  const extra = module.namespace;
  extra.configure({ install: async () => ({ extra: [] }), Lines: class {}, sleep: async () => {}, within: (_cx, p) => p });
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
  assert.deepEqual(JSON.parse(JSON.stringify(adopted)), { rows: [{ terminal: "app:t5", address: "t5", hub: "laptop" }], counts: { total: 1, unread: 0 } });
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
  const opened = { stopped: false, stop() { this.stopped = true; } };
  const open = (_cx, _opts, onMessage) => ((deliver = onMessage), opened);
  const got = [];
  const { cx, tick } = copy();
  const sub = extra.withExtras(open, cx, { views: ["agents"] }, (m) => got.push(m), () => {});
  deliver({ view: "agents", value: { agents: [{ address: "t7" }] } }, cx);
  deliver({ view: "home", value: { merged: [] } }, cx);
  assert.deepEqual(JSON.parse(JSON.stringify(got.map((m) => [m.view, m.value.extra ?? null]))), [["agents", null], ["home", null]]);
  // A follower's news: the laptop's agents arrive.
  context.cockpitExtraHubs.followers.set("laptop", { name: "laptop", value: { rows: [{ address: "t5", hub: "laptop" }], counts: {} }, alive: Date.now() });
  context.cockpitExtraHubs.version += 1;
  tick();
  assert.equal(got.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(got[2].value.extra)), [{ name: "laptop", rows: [{ address: "t5", hub: "laptop" }], counts: {} }]);
  tick();
  assert.equal(got.length, 3, "nothing moved: nothing sent again");
  sub.stop();
  assert.equal(opened.stopped, true);
});
