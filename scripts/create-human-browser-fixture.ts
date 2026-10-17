import {writeFile} from 'node:fs/promises';
import {decodeArchive} from '../src/shared/archive.js';
import type {RunState} from '../src/shared/types.js';
const base='http://127.0.0.1:4321';
async function post(path:string,body:unknown){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error(await response.text());return decodeArchive<RunState>(await response.json());}
const run=await post('/api/runs',{seed:'first-light-42',civilizationCount:12,segmentTicks:6,mode:'offline',humanCivilizationId:'civ-1'});
await post(`/api/runs/${run.id}/step`,{});
const snapshot=await(await fetch(base+`/api/runs/${run.id}/export`)).json();
await writeFile('output/human-browser-start.json',JSON.stringify(snapshot));
await writeFile('output/human-browser-id.txt',run.id);
console.log(run.id);
