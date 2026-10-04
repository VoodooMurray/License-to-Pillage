// The source the web engine runs for a data script (engine/steps.js), for the ScummVM compiler: reads
// [{handler, dialogues}, ...] as JSON on stdin, prints [source, ...] (each an `async g => {...}` arrow function).
//   echo '[{"handler": {"do": [{"say": "Hi"}]}, "dialogues": {}}]' | node tools/js/steps_src.mjs
import { handlerSource } from '../../engine/steps.js';

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const jobs = JSON.parse(input || '[]');
  process.stdout.write(JSON.stringify(jobs.map(j => handlerSource(j.handler, { dialogues: j.dialogues || {}, cards: j.cards || {} }))));
});
