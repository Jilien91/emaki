// Proves a deck edit changed nothing but mnemonics.
//
//   node scripts/deck-guard.js [ref]        default ref: HEAD
//
// Run after every batch of the mnemonic rewrite, before committing.
//
// Lasz's progress is keyed by word id and lives in localStorage and the
// Supabase user_state row. Nothing in the SRS reads mnemonic text, so rewriting
// mnemonics cannot move a stage, a streak or a review date — but only as long
// as id, word and reading stay exactly where they are. An id that shifts
// silently repoints every stage in his account at a different word, and there
// would be no error anywhere: the deck would simply start testing him on the
// wrong things at the right intervals.
//
// So this checks the invariant rather than trusting it. Every field except
// mnemonic must be byte-identical to the reference, the word count must match,
// and the ids must be the same set in the same order.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ref = process.argv[2] || 'HEAD';
const file = path.join(__dirname, '..', 'data', 'vocab.json');

const now = JSON.parse(fs.readFileSync(file, 'utf8'));
const was = JSON.parse(execSync('git show ' + ref + ':data/vocab.json',
  { encoding: 'utf8', maxBuffer: 1 << 28, cwd: path.join(__dirname, '..') }));

let fatal = 0;

if(now.length !== was.length){
  console.log('FATAL  word count changed: ' + was.length + ' -> ' + now.length);
  fatal++;
}

const GUARDED = ['id', 'word', 'reading', 'meaning', 'frequency',
                 'notes', 'sentence', 'sentence_meaning'];

const n = Math.min(now.length, was.length);
let changed = 0;
for(let i = 0; i < n; i++){
  const a = was[i], b = now[i];
  for(const k of GUARDED){
    if(JSON.stringify(a[k]) !== JSON.stringify(b[k])){
      console.log('FATAL  index ' + i + ' (' + (a.word || '?') + ') field "' + k + '" changed');
      console.log('         was: ' + JSON.stringify(a[k]));
      console.log('         now: ' + JSON.stringify(b[k]));
      fatal++;
    }
  }
  // Any key appearing or disappearing is also a change worth stopping for.
  const ka = Object.keys(a).sort().join(','), kb = Object.keys(b).sort().join(',');
  if(ka !== kb){
    console.log('FATAL  index ' + i + ' (' + (a.word || '?') + ') fields changed: ' + ka + ' -> ' + kb);
    fatal++;
  }
  if(a.mnemonic !== b.mnemonic) changed++;
}

// Belt and braces: the id sequence itself, compared as one string.
const idsWas = was.map(w => w.id).join(','), idsNow = now.map(w => w.id).join(',');
if(idsWas !== idsNow){
  console.log('FATAL  the id sequence itself moved. Progress is keyed on these.');
  fatal++;
}

console.log('');
console.log('  words              ' + now.length);
console.log('  mnemonics changed  ' + changed);
console.log('  everything else    ' + (fatal ? 'CHANGED — see above' : 'byte-identical to ' + ref));

if(fatal){
  console.log('\n' + fatal + ' problem(s). Do not commit this.');
  process.exit(1);
}
console.log('\nSafe: ids, words and readings are exactly as they were, so no');
console.log('stage, streak or review date can have moved.');
