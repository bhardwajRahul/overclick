// OCL-213 — splits task_create write time by part: contract, origem, harness,
// project, the JSON around como_confirmo, and model start + thinking.
//   node parts.mjs <since-iso> [until-iso]   (run where mine-claude.mjs wrote
//   claude-calls.jsonl and claude-payloads.jsonl, see scripts/ocl-209)
// Seconds per part = chars / 1.95 chars per token / the model writing speed
// measured in OCL-209. Text como_confirmo (OCL-213) counts as contract.
import fs from "node:fs";
const since = process.argv[2]; const until = process.argv[3] || "9999";
const SPEED={ "claude-opus-5":86,"claude-opus-5-5":128,"claude-sonnet-5":147,"claude-fable-5":80 };
const calls = new Map(fs.readFileSync("claude-calls.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse).filter(r=>r.tool==="task_create"&&r.date>=since&&r.date<until&&r.msg_tool_uses===1).map(r=>[r.call_id,r]));
const pays = fs.readFileSync("claude-payloads.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse).filter(p=>calls.has(p.call_id));
const q=(v,p)=>{v=v.filter(x=>x!=null&&!isNaN(x)).sort((a,b)=>a-b);if(!v.length)return null;return v[Math.floor((v.length-1)*p)]};
const parts={}; const add=(k,v)=>(parts[k]??=[]).push(v);
const byMission=new Map();
for(const p of pays){const c=calls.get(p.call_id); let a; try{a=JSON.parse(p.args)}catch{continue} if(a.__unparsedToolInput) continue;
 const sp=SPEED[(c.model||"").replace(/\[.*$/,"").replace(/-\d{8}$/,"")]||86; const sec=ch=>ch/1.95/sp;
 add("write_s",c.write_s); add("args_chars",p.args.length);
 add("contract_s",sec(JSON.stringify(a.o_que??"").length+JSON.stringify(a.por_que??"").length+JSON.stringify(a.como_confirmo??"").length));
 add("harness_s",sec(a.harness?JSON.stringify(a.harness).length+10:0));
 add("origem_s",sec(a.origem?JSON.stringify(a.origem).length+9:0));
 add("project_s",sec(a.project_id?JSON.stringify(a.project_id).length+13:0));
 if(Array.isArray(a.como_confirmo)){const j=JSON.stringify(a.como_confirmo).length;const t=a.como_confirmo.map(s=>`${s.step} → ${s.expected}`).join("\n");add("cc_json_overhead_chars",j-JSON.stringify(t).length);add("cc_json_overhead_s",sec(j-JSON.stringify(t).length));add("cc_steps",a.como_confirmo.length)}
 if(a.mission){if(!byMission.has(a.mission))byMission.set(a.mission,[]);byMission.get(a.mission).push({o:a.o_que||"",sec,c})}
 add("ttft_think_s", c.write_s - sec(p.args.length));
}
// (b) duplicated lines: sentences >=60 chars of o_que that appear verbatim in an earlier sibling card of the same mission
let dupS=[], dupShare=[];
for(const [m,cs] of byMission){const seen=new Set();for(const x of cs){const sents=x.o.split(/(?<=[.!?:])\s+|\n+/).map(s=>s.trim()).filter(s=>s.length>=60);let d=0;for(const s of sents){if(seen.has(s))d+=s.length}for(const s of sents)seen.add(s);dupS.push(x.sec(d));dupShare.push(x.o.length?d/x.o.length:0)}}
for(const [k,v] of Object.entries(parts)){const mean=v.reduce((a,b)=>a+(b||0),0)/v.length;console.log(k.padEnd(22),"n",v.length,"p50",q(v,.5)?.toFixed(2),"mean",mean.toFixed(2))}
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
console.log("mission cards",dupS.length,"dup-from-sibling s mean",mean(dupS).toFixed(2),"share of o_que mean",(100*mean(dupShare)).toFixed(1)+"%","cards with any dup",dupShare.filter(x=>x>0).length);
