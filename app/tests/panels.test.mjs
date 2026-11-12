import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
import {test} from 'node:test';
async function fixture() {
 const state={}, view={tree:{id:"panel",hidden:true,children:[{id:"panel-body",active:"review"}]}};
 const callbacks=[],calls=[],context=createContext({console}),sources=new Map(),modules=new Map();
 const imports={herdr:{shared:key=>state[key],setShared:(key,value)=>{state[key]=value},layout:()=>view.tree},'./hub.js':{subscribe:(_cx,opts,onMessage)=>{callbacks.push(onMessage);calls.push(opts);return {stop(){}}},install:async()=>({machine:'runner'})}};
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
 const module=new SourceTextModule('export {default as Runbook,slugFor} from "./runbook.js"; export {default as Show} from "./show.js";',{context});
 await module.link(load);await module.evaluate();return {mod:module.namespace,calls,state,view,callbacks};
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
test('last owner write wins over the runbooks editable updated field',async()=>{
 const {mod}=await fixture();assert.equal(mod.slugFor([
  {slug:'old-date',owner:{terminal:'app:t7',at:200},updated:'2020-01-01'},
  {slug:'new-date',owner:{terminal:'app:t7',at:100},updated:'2030-01-01'}],[],'t7',null,{}),'old-date');
});


test('hidden Documents updates set a badge that clears when the tab is viewed',async()=>{
 const f=await fixture(),show=new f.mod.Show();show.panel=true;
 show.data={views:[{name:'quota',at:1}],view:{name:'quota',at:1,blocks:[]}};show.updateBadge();
 show.data={views:[{name:'quota',at:2}],view:{name:'quota',at:2,blocks:[]}};show.updateBadge();
 assert.equal(f.state['badge.show'].count,1);
 f.view.tree.hidden=false;f.view.tree.children[0].active='show';show.updateBadge();
 assert.equal(f.state['badge.show'],null);
});
test('hidden Runbook updates set a badge that clears when the tab is viewed',async()=>{
 const f=await fixture(),book=new f.mod.Runbook();book.panel=true;
 book.model={books:[{slug:'eng-412',steps:[{n:'1',open:true}]}]};book.updateBadge();
 book.model={books:[{slug:'eng-412',steps:[{n:'1',open:false}]}]};book.updateBadge();
 assert.equal(f.state['badge.runbook'].count,1);
 f.view.tree.hidden=false;f.view.tree.children[0].active='runbook-panel';book.updateBadge();
 assert.equal(f.state['badge.runbook'],null);
});
test('an unselected blueprint revision lights the Documents badge without changing the selected document',async()=>{
 const f=await fixture(),show=new f.mod.Show();show.panel=true;
 const selected={name:'quota',at:2,blocks:[]};
 show.data={views:[{name:'quota',at:2,revision:'quota-1'},{name:'blueprint',at:1,revision:'plan-1'}],view:selected};show.updateBadge();
 show.data={views:[{name:'quota',at:2,revision:'quota-1'},{name:'blueprint',at:1,revision:'plan-2'}],view:selected};show.updateBadge();
 assert.equal(f.state['badge.show'].count,1);
 assert.equal(show.data.view.name,'quota');
});

test('focusing a local or foreign terminal stops Documents and clears the old agent',async()=>{
 for(const terminal of ['t7','other/t7']) {
  const f=await fixture(),show=new f.mod.Show();let stopped=0,notified=0;
  Object.assign(show,{panel:true,terminal,machine:'runner',pick:'quota',data:{view:{name:'quota'}},sub:{stop:()=>stopped++}});
  assert.doesNotThrow(()=>show.subscribe({notify:()=>notified++}));
  assert.equal(stopped,1);assert.equal(f.calls.length,0);assert.equal(show.data,null);assert.ok(notified);
 }
});


test('a stopped Documents subscription cannot restore the previously focused agent',async()=>{
 const f=await fixture(),show=new f.mod.Show(),cx={notify(){}};
 Object.assign(show,{panel:true,terminal:'runner/t7',machine:'runner',pick:null,data:null});
 show.subscribe(cx);show.terminal='t7';show.subscribe(cx);
 f.callbacks[0]({view:'show',value:{view:{name:'old',blocks:[]}}},cx);
 assert.equal(show.data,null);
});
