import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const source = await readFile(new URL("../mods/cockpit/address.js", import.meta.url), "utf8");
const { toRunner, toDesktop, argsToRunner } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test("terminal addresses preserve raw and app handle forms", () => {
  for (const [desktop, runner] of [["runner/t7","t7"],["app:runner/t7","app:t7"]]) {
    assert.equal(toRunner(desktop,"runner"),runner);
    assert.equal(toDesktop(runner,"runner"),desktop);
    assert.equal(toRunner(runner,"runner"),runner);
    assert.equal(toDesktop(desktop,"runner"),desktop);
  }
  assert.throws(() => toRunner("app:other/t7","runner"), /another machine/);
  assert.throws(() => toRunner("other/t7","runner"), /another machine/);
});
test("action arguments translate nested terminal addresses and preserve ordinary text", () => {
  assert.deepEqual(argsToRunner([{terminal:"app:runner/t7",next:{terminal:"runner/t9"},text:"see runner/t7 later"}],"runner"),
    [{terminal:"app:t7",next:{terminal:"t9"},text:"see runner/t7 later"}]);
  assert.throws(() => argsToRunner(["other/t7"],"runner"), /another machine/);
});
