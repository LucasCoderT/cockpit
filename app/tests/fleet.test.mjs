import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

async function fixture(desktop = {}) {
  const calls = [], notices = [];
  const context = createContext({ console });
  const imports = {
    herdr: {
      agents: () => [{ address: "t7", tab: "tab7", space: "s1", status: "working", title: "Local agent" }],
      spaces: () => desktop.spaces ?? [{ id: "s1", tabs: [{ id: "tab7" }] }],
      panes: () => desktop.panes ?? [],
      run: (...args) => calls.push(args),
      setShared: (...args) => calls.push(["shared", ...args]),
      notify: notice => notices.push(notice),
    },
    "./hub.js": { act: async (...args) => { calls.push(["act", ...args]); return {}; } },
  };
  const sources = new Map(), modules = new Map();
  const folder = new URL("../mods/cockpit/", import.meta.url);
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    const text = await readFile(new URL(name, folder), "utf8");
    sources.set(`./${name}`, text);
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
      const exports = imports[match[2]] ??= {};
      for (const word of match[1].split(",")) {
        const key = word.trim().split(/\s+as\s+/)[0];
        exports[key] ??= () => { throw new Error(`unexpected native call: ${key}`); };
      }
    }
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const native = imports[name];
    const module = native
      ? new SyntheticModule(Object.keys(native), function () {
        for (const [key, value] of Object.entries(native)) this.setExport(key, value);
      }, { context })
      : new SourceTextModule(sources.get(name), { context, identifier: name });
    modules.set(name, module);
    return module;
  }
  const module = new SourceTextModule('export * from "./fleet.js"; export { default as Home } from "./home.js"; export { default as Sidebar } from "./sidebar.js"; export { AgentsModel } from "./agentsui.js";', { context });
  await module.link(load);
  await module.evaluate();
  return { fleet: module.namespace, calls, notices };
}

test("a runner's t7 stays separate from local t7 and Go focuses the runner's terminal", async () => {
  const f = await fixture();
  const model = { remote: "runner", agents: [{ address: "t7", terminal: "app:t7", frontend: "app", title: "Runner agent", stage: "done", tab: { id: "tab7" } }] };
  const rows = f.fleet.fleet(model, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Runner agent");
  assert.equal(rows[0].address, "runner/t7");
  assert.equal(rows[0].remote, "runner");
  assert.equal(rows[0].status, undefined);
  f.fleet.goToAgent(rows[0]);
  assert.equal(f.calls[0][0], "agent.focus");
  assert.equal(f.calls[0][1].terminal, "runner/t7");
  assert.equal(f.notices.length, 0);
});

test("local agents retain their metadata join and navigation", async () => {
  const f = await fixture();
  const [row] = f.fleet.fleet({ agents: [{ address: "t7", title: "Local task" }] }, {});
  assert.equal(row.title, "Local task");
  assert.equal(row.status, "working");
  assert.equal(row.tab, "tab7");
  f.fleet.goToAgent(row);
  assert.equal(f.calls[0][0], "agent.focus");
  assert.equal(f.calls[0][1].terminal, "t7");
  assert.equal(f.notices.length, 0);
});

test("remote Go, Peek and Open beside navigate to the runner's terminal; an agent absent from this desktop cannot be archived", async () => {
  const f = await fixture();
  const model = { remote: "runner", agents: [{ address: "t7", terminal: "app:t7", title: "Runner agent", tab: { id: "tab7" } }] };
  const agents = Object.create(f.fleet.AgentsModel.prototype);
  agents.value = model;
  const row = agents.rows[0];
  const cx = { notify() {}, spawn: f => f(cx) };
  agents.busy = new Map();
  assert.equal(new f.fleet.Sidebar().subRows({}, row).length, 0);
  agents.go(cx, row);
  agents.command(`agents|peek|${row.terminal}|`, cx);
  const home = new f.fleet.Home();
  const [agent] = f.fleet.fleet(model, {});
  home.openBeside(cx, agent);
  home.archive(cx, agent);
  home.archiveAll(cx, [{ agent }]);
  assert.deepEqual(f.calls.filter(c => c[1]?.terminal).map(c => `${c[0]} ${c[1].terminal}`), [
    "agent.focus runner/t7",
    "terminal.peek runner/t7",
    "agent.focus runner/t7",
  ]);
  assert.equal(f.calls.some(c => c[0] === "tab.settle"), false);
  assert.equal(f.notices.length, 2);
  assert.equal(f.calls.find(c => c[0] === "act")[2], "seen");
});

test("local Go, Peek, Open beside and Archive handlers retain their commands", async () => {
  const f = await fixture();
  const model = { agents: [{ address: "t7", terminal: "app:t7", title: "Local task", herdr: true }] };
  const agents = Object.create(f.fleet.AgentsModel.prototype);
  agents.value = model;
  const row = agents.rows[0];
  const cx = { notify() {}, spawn: f => f(cx) };
  agents.busy = new Map();
  agents.go(cx, row);
  agents.command(`agents|peek|${row.terminal}|`, cx);
  const home = new f.fleet.Home();
  home.toasts = { push() {} };
  const [agent] = f.fleet.fleet(model, {});
  home.openBeside(cx, agent);
  home.archive(cx, agent);
  home.archiveAll(cx, [{ agent }]);
  assert.deepEqual(f.calls.map(c => c[0]), ["agent.focus", "layout.select", "terminal.peek", "agent.focus", "layout.show", "tab.settle", "tab.settle"]);
  assert.equal(f.calls.at(-1)[1].id, "tab7");
  assert.equal(f.notices.length, 0);
});


test("remote Archive uses the owning desktop tab and Undo restores that tab", async () => {
 const desktop={spaces:[{id:"local",machine:null,tabs:[{id:"tab7"}]},{id:"remote",machine:"runner",tabs:[{id:"mac-tab9"}]}],
  panes:[{terminal:"t7",tab:"tab7"},{terminal:"runner/t7",tab:"mac-tab9"}]};
 const f=await fixture(desktop),home=new f.fleet.Home(),toasts=[];
 home.toasts={push:(_cx,_text,options)=>toasts.push(options)};
 const agent={remote:"runner",address:"runner/t7",tab:"tab7",title:"ENG-412"};
 home.archive({notify(){}},agent);
 assert.equal(f.calls.at(-1)[0],"tab.settle");assert.equal(f.calls.at(-1)[1].id,"mac-tab9");
 toasts[0].action.onClick();assert.equal(f.calls.at(-1)[0],"tab.unsettle");assert.equal(f.calls.at(-1)[1].id,"mac-tab9");
 desktop.spaces[1].tabs[0].settled=true;
 home.rows={remote:"runner",agents:[{address:"t7",title:"ENG-412",tab:{id:"tab7"}}]};home.home={};home.stages=new Map();
 assert.equal(home.cards()[0].archived,true);
 assert.equal(f.calls.some(c=>c[0]==="tab.settle" && c[1].id==="tab7"),false);
});

test("Archive all maps remote tabs, deduplicates them and supports Undo",async()=>{
 const f=await fixture({spaces:[{id:"remote",machine:"runner",tabs:[{id:"mac-tab9"}]}],
  panes:[{terminal:"runner/t7",tab:"mac-tab9"},{terminal:"runner/t8",tab:"mac-tab9"}]}),home=new f.fleet.Home(),toasts=[];
 home.toasts={push:(_cx,_text,options)=>toasts.push(options)};
 home.archiveAll({notify(){}},[{agent:{remote:"runner",address:"runner/t7",tab:"tab7"}},
  {agent:{remote:"runner",address:"runner/t8",tab:"tab8"}},{agent:{address:"t9",tab:"local-tab9"}}]);
 assert.deepEqual(f.calls.filter(c=>c[0]==="tab.settle").map(c=>c[1].id),["mac-tab9","local-tab9"]);
 toasts[0].action.onClick();
 assert.deepEqual(f.calls.filter(c=>c[0]==="tab.unsettle").map(c=>c[1].id),["mac-tab9","local-tab9"]);
});

test("remote Archive refuses a terminal found only in a local or another machine's space",async()=>{
 const f=await fixture({spaces:[{id:"local",machine:null,tabs:[{id:"tab7"}]}],panes:[{terminal:"runner/t7",tab:"tab7"}]}),home=new f.fleet.Home();
 home.archive({notify(){}},{remote:"runner",address:"runner/t7",tab:"tab7",title:"ENG-412"});
 assert.equal(f.calls.some(c=>c[0]==="tab.settle"),false);
 assert.equal(f.notices[0].title.includes("Read-only"),false);
});
