// Words that share a reading, and therefore must not share a mnemonic hook.
//
//   node scripts/reading-collisions.js            all of them
//   node scripts/reading-collisions.js 393 450    only those touching an id range
//
// The mnemonic rewrite hangs an English sound-hook on each reading. Two words
// with the same reading and the same hook are worse than no hook at all: the
// reader recalls the scene and cannot tell which word it belongs to. 起きる
// already had "okay" when 怒る came up needing one, and 怒る got ochre instead.
//
// Run this before writing a batch and check the range you are about to touch.
const v = require('../data/vocab.json');
const by = {};
v.forEach(w => { (by[w.reading] = by[w.reading] || []).push(w); });

const [lo, hi] = process.argv.slice(2).map(Number);
const inRange = w => !lo || (w.id >= lo && w.id <= (hi || lo));

const dups = Object.keys(by)
  .filter(r => by[r].length > 1)
  .filter(r => !lo || by[r].some(inRange))
  .sort((a, b) => by[b].length - by[a].length || a.localeCompare(b));

for(const r of dups){
  console.log(r + '  ->  ' + by[r]
    .map(w => (inRange(w) ? '*' : ' ') + w.word + '(' + w.id + ') ' + w.meaning.split(',')[0])
    .join('  |  '));
}
console.log('\n' + dups.length + ' shared reading(s)' +
  (lo ? ' touching ids ' + lo + '-' + (hi || lo) + '; * marks the ones in range' : '') +
  ', ' + dups.reduce((n, r) => n + by[r].length, 0) + ' words');
