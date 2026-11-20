import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// screens.js alone, Herdr's natives stubbed: `layout` names the layout in front.
async function load(layout = "cockpit") {
  const context = createContext({ console });
  const stubs = {
    herdr: { run: () => {}, shared: (k) => (k === "layout" ? layout : null), setShared: () => {}, layout: () => ({}), focused: () => null, agents: () => [] },
    "./person.js": { keyed: (c) => c },
  };
  const source = await readFile(new URL("../mods/cockpit/screens.js", import.meta.url), "utf8");
  const module = new SourceTextModule(source, { context });
  await module.link((name) => new SyntheticModule(Object.keys(stubs[name]), function () {
    for (const [k, v] of Object.entries(stubs[name])) this.setExport(k, v);
  }, { context }));
  await module.evaluate();
  return module.namespace;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test("Cockpit Chat's app strip reaches the tab's panes: Home, Needs you, then Tab", async () => {
  const chat = await load("cockpit-chat");
  assert.deepEqual(plain(chat.stripLeads()), [
    { child: "home", label: "Home", icon: "layout-dashboard", command: "cockpit.go:home" },
    { child: "needs", label: "Needs you", icon: "hand", command: "cockpit.go:needs" },
    { child: "tab", label: "Tab", icon: "terminal", command: "cockpit.go:tab" },
  ]);
  // Tab is a screen the chat layout has, which its `go:` command shows (commands.js checks the same list).
  assert.ok(chat.screensOf("cockpit-chat").list.some((s) => s.child === "tab"));
});

test("the cockpit layout keeps Home alone before its pinned apps: its panes are the work area itself", async () => {
  const cockpit = await load("cockpit");
  assert.deepEqual(plain(cockpit.stripLeads().map((s) => s.child)), ["home"]);
  assert.deepEqual(plain(cockpit.stripLeads("cockpit-chat").map((s) => s.child)), ["home", "needs", "tab"], "a layout named outright");
  assert.deepEqual(plain(cockpit.stripLeads("win98").map((s) => s.child)), ["home"], "another layout reads as the cockpit one");
});
