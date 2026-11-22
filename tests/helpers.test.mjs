import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, parseMemory, isOwner, safeTaskId } from '../src/helpers.js';
test('task routing',()=>{
 assert.equal(classifyTask('create tiktok video'),'video_demo');
 assert.equal(classifyTask('review metadata'),'report');
});
test('memory parsing',()=>{
 assert.deepEqual(parseMemory('/remember video.language=Khmer'),{key:'video.language',value:'Khmer'});
 assert.equal(parseMemory('/remember invalid'),null);
});
test('owner validation',()=>{
 assert.equal(isOwner(123,'123'),true);
 assert.equal(isOwner(123,'124'),false);
});
test('task ID shape',()=>{
 assert.equal(safeTaskId('BSK-12345678-1234-1234-1234-123456789abc'),true);
 assert.equal(safeTaskId('junk'),false);
});
import { parseCommand, anthropicHint, githubHint } from '../src/helpers.js';
test('command parsing',()=>{
 assert.deepEqual(parseCommand('/task  make a video '),{cmd:'task',args:'make a video'});
 assert.deepEqual(parseCommand('/Status@BookShareBot'),{cmd:'status',args:''});
 assert.equal(parseCommand('hello'),null);
});
test('error hints are actionable',()=>{
 assert.match(anthropicHint(401),/ANTHROPIC_API_KEY/);
 assert.match(githubHint(403),/Actions: Read and write/);
});
