import type {EngineInterface} from 'claude-code'
import {cacheDir,home,writeAtomic} from './config'
import {appDo,hereSoon,frontendOf} from './herdr'

// Records which agent wrote a runbook and opens a new one beside that agent.
export async function noteRunbookWrite($:EngineInterface,filePath:string,existedBefore:boolean):Promise<void> {
 const slug=await runbookSlug($,filePath)
 if(!slug) return
 const cache=await cacheDir($)
 const here=await hereSoon($),frontend=here?.frontend ?? await frontendOf($)
 const terminal=here?.pane ?? (frontend==='app' ? `app:${await $.env.get('HC_TERMINAL_ID')}` : null)
 const owner={terminal,session:await $.session.id(),at:Date.now()}
 // Per-book records also serve step handoffs and keep simultaneous writers to different books independent.
 await $.process.run(['mkdir','-p',`${cache}/runbook-owners`])
 await writeAtomic($,`${cache}/runbook-owners/${slug}.json`,JSON.stringify({...owner,pane:terminal}))
 const owners=JSON.parse(await $.fs.read(`${cache}/runbook-owners.json`).catch(()=>'{}')) as Record<string,unknown>
 owners[slug]=owner
 await writeAtomic($,`${cache}/runbook-owners.json`,JSON.stringify(owners))
 if(!existedBefore && frontend==='app' && terminal?.startsWith('app:')) {
   const focused=await appDo($,'pane.focus',{terminal:terminal.slice(4)})
   if(focused) await appDo($,'cockpit.panel-open:runbook',{})
 }
}

// The slug of a file in the configured flat runbook directory.
export async function runbookSlug($:EngineInterface,filePath:string):Promise<string|undefined> {
 const dir=((await $.env.get('COCKPIT_RUNBOOKS_DIR')) || `${await home($)}/.config/cockpit/runbooks`).replace(/\/+$/,'')
 if(!filePath.startsWith(`${dir}/`)) return undefined
 const name=filePath.slice(dir.length+1)
 return /^[a-z0-9][a-z0-9-]*\.md$/i.test(name) ? name.slice(0,-3) : undefined
}
