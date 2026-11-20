import {expect,test} from 'claude-code/testing'
const HOME='/home/me',CACHE=`${HOME}/.cache/cockpit`,PATH=`${HOME}/.config/cockpit/runbooks/eng-412.md`
const ran=(stdout='')=>({exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false})
function setup(on:Parameters<Parameters<typeof test>[1]>[1]) {
 const files=new Map<string,string>([[PATH,'# ENG-412\nold'],[`${HOME}/.config/cockpit/herdr/cockpit.sh`,''],[`${CACHE}/runbook-owners/eng-412.json`,JSON.stringify({terminal:'app:t7',pane:'app:t7',session:'acme-old',at:1})]]);
 let clock=1;const stamps=new Map<string,number>();
 on('session.id',()=>({value:'acme-new'}));
 on('session.cwd',()=>({value:'/src/acme/api'}));
 on('env.get',(_,e)=>({value:({HOME,HC_TERMINAL_ID:'t14'} as Record<string,string>)[e.name]}));
 on('fs.read',(_,e)=>{if(!files.has(e.path))throw Error('ENOENT');return {value:files.get(e.path)}});
 on('fs.stat',(_,e)=>{if(!files.has(e.path))throw Error('ENOENT');return {value:{kind:'file',size:files.get(e.path)!.length,mtimeMs:stamps.get(e.path)??1,isLink:false}}});
 on('fs.list',()=>({value:[]}));
 on('fs.write',(_,e)=>{files.set(e.path,e.text);stamps.set(e.path,++clock);return {value:undefined}});
 on('process.run',(_,e)=>{
  if(e.argv[0]==='mv'){const [from,to]=e.argv.slice(-2);files.set(to!,files.get(from!)!);files.delete(from!)}
  if(e.argv.join(' ').includes('command -v'))return {value:{...ran(),exitCode:1}}
  if(e.argv.at(-1)==='ls')return {value:ran(JSON.stringify({spaces:[{id:'s1',tabs:[{id:'tab1',terminals:[{terminal:'t14',pane:'p14'}]}]}]}))}
  return {value:ran('{}')}
 });
 return {files,write:(text:string)=>{files.set(PATH,text);stamps.set(PATH,++clock)}}
}
test('canceling runbook command and a failed edit preserve the existing owner',async($,on)=>{
 const f=setup(on),before=f.files.get(`${CACHE}/runbook-owners/eng-412.json`);
 on('command.run',()=>({text:'canceled'}));
 on('tool.call',()=>({result:{isError:true,error:'edit failed'}}));
 await $.command.run({command:'runbook',args:'ENG-412'});
 expect(f.files.get(`${CACHE}/runbook-owners/eng-412.json`)).toBe(before);
 await $.tool.call({tool:'Edit',file_path:PATH,old_string:'missing',new_string:'new'});
 expect(f.files.get(`${CACHE}/runbook-owners/eng-412.json`)).toBe(before);
});
test('a successful write through registered hooks records the actual writer',async($,on)=>{
 const f=setup(on);
 on('tool.call',()=>{f.write('# ENG-412\nnew');return {result:{}}});
 await $.tool.call({tool:'Write',file_path:PATH,content:'# ENG-412\nnew'});
 expect(JSON.parse(f.files.get(`${CACHE}/runbook-owners/eng-412.json`)!).terminal).toBe('app:t14');
});
