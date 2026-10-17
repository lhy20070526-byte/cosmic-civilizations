import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {factCardsV2,templateNarrative} from '../src/server/narrative.js';
import {checksum,exportSnapshot,importSnapshot} from '../src/server/snapshot.js';

const legacyArchive=()=>JSON.parse(readFileSync(new URL('../output/feedback-browser-snapshot.json',import.meta.url),'utf8'));

test('legacy narrative snapshot restores and a version 2 narrative round-trips',()=>{
 const legacy=importSnapshot(legacyArchive());
 assert.ok(legacy.narratives.length>0);
 assert.equal(legacy.narratives[0].factVersion,undefined);

 const narrative=templateNarrative(legacy);
 assert.equal(narrative.factVersion,2);
 assert.match(narrative.facts.find(card=>card.id==='v2-overview')?.text??'',/观察跨越 30 轮/);
 const relation=narrative.facts.filter(card=>card.layer==='relation');
 assert.ok(relation.some(card=>card.text.includes('提出合作提案')));
 assert.ok(relation.some(card=>card.text.includes('合作结果已发出')));
 assert.ok(relation.every(card=>card.fromTick!==undefined&&card.toTick!==undefined&&card.fromTick<=card.toTick));
 assert.ok(relation.every(card=>!card.text.includes('攻击发射')) || relation.some(card=>card.id==='v2-no-conflict'));

 const withNarrative=structuredClone(legacy);
 withNarrative.narratives=[narrative];
 const restored=importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(withNarrative))));
 assert.equal(restored.narratives[0].factVersion,2);
 assert.deepEqual(restored.narratives[0].cards,narrative.cards);
});

test('version 2 relation cards keep interaction evidence distinct from attack evidence',()=>{
 const run=importSnapshot(legacyArchive());
 const cards=factCardsV2(run);
 const relation=cards.filter(card=>card.layer==='relation');
 assert.ok(relation.some(card=>card.text.includes('发出')&&card.text.includes('联络')));
 assert.ok(relation.some(card=>card.text.includes('提出合作提案')));
 assert.ok(relation.some(card=>card.text.includes('拒绝收到的提案')));
 assert.ok(relation.some(card=>card.text.includes('同意收到的提案')));
 assert.ok(relation.some(card=>card.text.includes('合作结果已发出')&&card.text.includes('接收记录')));
 const ending=cards.find(card=>card.id==='v2-ending');
 assert.ok(ending);
 assert.match(ending!.text,/攻击发射 0 次，攻击相关损伤 0/);
 assert.doesNotMatch(ending!.text,/攻击结果/);
 assert.ok(cards.every(card=>!/[0-9]+\.[0-9]{2,}/.test(card.text)));
});

test('unknown narrative fact versions are rejected during restore',()=>{
 const run=importSnapshot(legacyArchive());
 const snapshot=exportSnapshot(run) as any;
 snapshot.narrative[0].factVersion=99;
 snapshot.engineState.narratives[0].factVersion=99;
 const {checksum:_,...body}=snapshot;
 snapshot.checksum=checksum(body);
 assert.throws(()=>importSnapshot(snapshot),/未知叙事事实版本/);
});
