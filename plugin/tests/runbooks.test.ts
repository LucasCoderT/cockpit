import {expect,test} from 'claude-code/testing'
import {noteRunbookWrite} from '../hooks/runbooks'
const HOME='/home/me', DIR=`${HOME}/.config/cockpit/runbooks`, CACHE=`${HOME}/.cache/cockpit`
const ran=(exitCode:number,stdout='')=>({exitCode,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false})
function fixture() {
 const files=new Map<string,string>([[`${HOME}/.config/cockpit/herdr/cockpit.sh`,'']]),calls:string[][]=[]
 const $={env:{get:async(k:string)=>({HOME,HC_TERMINAL_ID:'t14'} as Record<string,string>)[k]},
 session:{id:async()=> 'acme-session',cwd:async()=>'/src/acme/api'},
 fs:{read:async(p:string)=>{if(!files.has(p))throw Error('ENOENT');return files.get(p)!},write:async(p:string,s:string)=>void files.set(p,s),
 stat:async(p:string)=>{if(!files.has(p))throw Error('ENOENT');return {size:1}}},
 process:{run:async(argv:string[])=>{calls.push(argv);if(argv[0]==='mv'){files.set(argv[2]!,files.get(argv[1]!)!);files.delete(argv[1]!)}
 if(argv.join(' ').includes('command -v'))return ran(1)
 if(argv.at(-1)==='ls') return ran(0,JSON.stringify({spaces:[{id:'s1',tabs:[{id:'tab1',terminals:[{terminal:'t14',pane:'p14'}]}]}]}))
 return ran(0,'{}')}}} as unknown as Parameters<typeof noteRunbookWrite>[0]
 return {$,files,calls}
}
test('a runbook write records its agent',async()=>{
 const f=fixture();await noteRunbookWrite(f.$,`${DIR}/eng-412.md`,true)
 const owner=JSON.parse(f.files.get(`${CACHE}/runbook-owners.json`)!)['eng-412']
 expect(owner.terminal).toBe('app:t14');expect(owner.session).toBe('acme-session');expect(typeof owner.at).toBe('number')
})
test('a new runbook opens the Runbook tab beside its agent',async()=>{
 const f=fixture();await noteRunbookWrite(f.$,`${DIR}/eng-412.md`,false)
 const calls=f.calls.filter(a=>a.includes('do'))
 expect(calls.map(a=>a[a.indexOf('do')+1])).toEqual(['pane.focus','cockpit.panel-open:runbook'])
 expect(JSON.parse(calls[0]!.at(-1)!)).toEqual({terminal:'t14'})
})
test('an update does not switch the tab',async()=>{
 const f=fixture();await noteRunbookWrite(f.$,`${DIR}/eng-412.md`,true)
 expect(f.calls.filter(a=>a.includes('do'))).toEqual([])
})
test('a write elsewhere is ignored',async()=>{
 const f=fixture();await noteRunbookWrite(f.$,'/src/acme/api/eng-412.md',false)
 await noteRunbookWrite(f.$,`${DIR}/../eng-412.md`,false)
 expect(f.calls).toEqual([])
})
