import test from 'node:test';
import assert from 'node:assert/strict';
import {personaInput} from '../src/server/persona.js';

test('new persona priors cover different motives and risk attitudes without receiving world truth',()=>{
  const inputs=Array.from({length:12},(_,i)=>personaInput('first-light-42',i+1));
  assert.equal(new Set(inputs.map(x=>x.dispositions.motivation)).size,12);
  assert.equal(new Set(inputs.map(x=>x.dispositions.riskPreference)).size,4);
  assert.equal(new Set(inputs.map(x=>x.dispositions.initialTrust)).size,4);
  assert.deepEqual(inputs,Array.from({length:12},(_,i)=>personaInput('first-light-42',i+1)));
  assert.notDeepEqual(inputs,Array.from({length:12},(_,i)=>personaInput('different',i+1)));
  for(const input of inputs)assert.deepEqual(Object.keys(input).sort(),['boundary','dispositions','ordinal','seed']);
});
