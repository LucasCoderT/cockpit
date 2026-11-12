import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
const execute=promisify(execFile);
test('local herdr-app lookup honors overrides, PATH and literal arguments',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cockpit-app-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'.local/bin'),{recursive:true});
 for(const name of ['.local/bin/herdr-app','primary','secondary'])await writeFile(join(root,name),'#!/bin/sh\nprintf \'%s\\n\' "$0" "$HERDR_APP_HOME" "$@"\n',{mode:0o755});
 const source=await readFile(new URL('../mods/cockpit/herdr-app.js',import.meta.url),'utf8');
 let vars={}, calls=[];
 const context=createContext({});
 const native=new SyntheticModule(['exec','appHome'],function(){
  this.setExport('appHome',()=>join(root,'app'));
  this.setExport('exec',async (bin,args,options)=>{
   calls.push({bin,args,options});
   const r=await execute(bin,args,{env:{HOME:root,PATH:'/usr/bin:/bin',...vars}});return {code:0,stdout:r.stdout,stderr:r.stderr};
  });
 },{context});
 const mod=new SourceTextModule(source,{context});await mod.link(()=>native);await mod.evaluate();
 const argv=['do','pane.split','$(touch /tmp/cockpit-unwanted) `echo unsafe` "quoted"'];
 for(const [env,name] of [[{HERDR_APP_BIN:join(root,'primary'),COCKPIT_HERDR_APP_BIN:join(root,'secondary')},'primary'],[{COCKPIT_HERDR_APP_BIN:join(root,'secondary')},'secondary'],[{},'.local/bin/herdr-app']]) {
  vars=env;const r=await mod.namespace.herdrApp(argv);
  assert.deepEqual(r.stdout.trimEnd().split('\n'),[join(root,name),join(root,'app'),...argv]);
  assert.equal(calls.at(-1).options,undefined);
 }
});
