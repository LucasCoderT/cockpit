import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
import {test} from 'node:test';
async function fixture() {
 const calls=[],context=createContext({console}),sources=new Map(),modules=new Map();
 const imports={herdr:{},'./hub.js':{subscribe:(_cx,opts)=>{calls.push(opts);return {stop(){}}},install:async()=>({machine:'runner'})}};
 const folder=new URL('../mods/cockpit/',import.meta.url);
 for(const name of await readdir(folder)) {
  if(!name.endsWith('.js'))continue;
  const text=await readFile(new URL(name,folder),'utf8');sources.set(`./${name}`,text);
  for(const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
   const exports=imports[m[2]]??={};for(const word of m[1].split(','))exports[word.trim().split(/\s+as\s+/)[0]]??=()=>{throw Error('unexpected native call')};
  }
 }
 function load(name) {
  if(modules.has(name))return modules.get(name);const native=imports[name];
  const module=native?new SyntheticModule(Object.keys(native),function(){for(const[k,v]of Object.entries(native))this.setExport(k,v)},{context}):new SourceTextModule(sources.get(name),{context,identifier:name});
  modules.set(name,module);return module;
 }
 const module=new SourceTextModule('export {slugFor} from "./runbook.js"; export {default as Show} from "./show.js";',{context});
 await module.link(load);await module.evaluate();return {mod:module.namespace,calls};
}
const books=[{slug:'eng-412',owner:{terminal:'app:t7',session:'acme-one'},updated:'2026-11-12 10:00'},
 {slug:'adr-notes',owner:{terminal:'app:t9',session:'acme-two'},updated:'2026-11-12 11:00'}];
test("the focused runner agent's own runbook wins",async()=>{
 const {mod}=await fixture();assert.equal(mod.slugFor(books,[],'runner/t7','runner',{}),'eng-412');
});
test("the owner's session finds it after the terminal changed",async()=>{
 const {mod}=await fixture();assert.equal(mod.slugFor(books,[{terminal:'app:t12',session:'acme-one'}],'runner/t12','runner',{}),'eng-412');
});
test('without an owner the ticket and branch still work',async()=>{
 const {mod}=await fixture(),plain=[{slug:'eng-412'},{slug:'adr-notes'}];
 assert.equal(mod.slugFor(plain,[{terminal:'app:t7',ticket:'ENG-412'}],'runner/t7','runner',{}),'eng-412');
 assert.equal(mod.slugFor(plain,[],'runner/t7','runner',{branch:'work-adr-notes'}),'adr-notes');
});
test('a local install matches its own handle and the latest owner write wins',async()=>{
 const {mod}=await fixture();assert.equal(mod.slugFor(books,[],'t7',null,{}),'eng-412');
 assert.equal(mod.slugFor([...books,{slug:'new-notes',owner:{terminal:'app:t7'},updated:'2026-11-12 12:00'}],[],'t7',null,{}),'new-notes');
});
test('Documents subscribes with the runner terminal address',async()=>{
 const {mod,calls}=await fixture(),show=new mod.Show();
 Object.assign(show,{panel:true,terminal:'runner/t7',machine:'runner',pick:null});
 show.subscribe({});assert.equal(calls[0].views[0].args.terminal,'t7');
});
