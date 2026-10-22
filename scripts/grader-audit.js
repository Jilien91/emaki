// What the meaning grader lets through, across the whole deck.
//
//   node scripts/grader-audit.js                 counts for the working tree
//   node scripts/grader-audit.js --against main  only what changed since main
//
// Every loosening of the grader has the same failure mode: a different word
// passing as a typo of the right one, silently, because a forgiven answer looks
// exactly like a correct one. Unit tests catch the pairs somebody thought of.
// This catches the ones nobody did, by trying every other card's meaning
// against every card, and every English word the deck uses against every card.
//
// Run it before changing fuzzyMatch, gradeMeaning or anything they call, and
// read the NEW lines rather than the totals. A total that moves by one can hide
// a bad acceptance behind a good one.
//
// History: this lived as a scratch script in September 2026 and was lost when
// the scratch folder was cleared. The handover said the audit "is in the
// session transcript", which was not a place anybody could run it from.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VOCAB = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vocab.json'), 'utf8'));
const KANJI = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'kanji.json'), 'utf8'));

// The grader is everything from levenshtein to just before checkReading. Taking
// the region rather than a list of names means a helper added later is picked up
// without anybody remembering to add it here.
function graderSource(appText){
  const text = appText.replace(/\r\n/g, '\n');
  const start = text.indexOf('\nfunction levenshtein(');
  const end = text.indexOf('\nfunction checkReading(');
  if(start < 0 || end < 0 || end < start) throw new Error('could not find the grader region in app.js');
  return text.slice(start, end);
}

function makeGrader(appText){
  const ctx = { VOCAB, KANJI };
  vm.createContext(ctx);
  vm.runInContext(graderSource(appText), ctx);
  // acceptedMeanings scans the whole deck on every call, which turns an audit
  // of a million comparisons into an afternoon. Same answers, cached per card.
  const real = ctx.acceptedMeanings;
  const cache = new Map();
  ctx.acceptedMeanings = (meaning, item) => {
    const k = item ? 'id:' + item.id : 'm:' + meaning;
    if(!cache.has(k)) cache.set(k, real(meaning, item));
    return cache.get(k);
  };
  // The app's own word list, so the audit asks exactly what the guard asks.
  let words = [];
  if(typeof ctx.isEnglishWord === 'function'){
    ctx.isEnglishWord('x');
    words = vm.runInContext('Array.from(englishWords || [])', ctx);
  }
  return { ctx, words, accepted: item => ctx.acceptedMeanings(item.meaning, item) };
}

const senses = v => [...new Set(v.meaning.replace(/\([^)]*\)/g, '')
  .split(/[,/]/).map(s => s.trim().toLowerCase()).filter(Boolean))];
const core = s => s.replace(/^to /, '');

function audit(grader){
  const { ctx, words } = grader;
  const all = [];
  VOCAB.forEach(b => senses(b).forEach(s => all.push([s, b])));
  const cross = new Set(), dict = new Set();
  for(const a of VOCAB){
    const own = new Set(senses(a));
    const ownCores = new Set(grader.accepted(a).map(core));
    const lens = grader.accepted(a).map(c => core(c).length);
    // No rule allows more than two edits, so anything further away cannot pass.
    const near = s => { const L = core(s).length; return lens.some(n => Math.abs(n - L) <= 3); };
    for(const [s, b] of all){
      if(b.id === a.id || b.word === a.word || own.has(s) || !near(s)) continue;
      if(ctx.checkMeaning(s, a.meaning, a)) cross.add(`${a.id} ${a.word} [${a.meaning}] accepts "${s}" (${b.word})`);
    }
    for(const w of words){
      if(ownCores.has(w) || !near(w)) continue;
      if(ctx.checkMeaning(w, a.meaning, a)) dict.add(`${a.id} ${a.word} [${a.meaning}] accepts "${w}"`);
    }
  }
  return { cross, dict };
}

const args = process.argv.slice(2);
const ref = args.includes('--against') ? args[args.indexOf('--against') + 1] : null;

const started = Date.now();
const now = audit(makeGrader(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')));
console.log(`working tree: ${now.cross.size} other cards' meanings accepted, ${now.dict.size} English words accepted`);

if(ref){
  const before = audit(makeGrader(execSync(`git show ${ref}:app.js`, { cwd: ROOT }).toString('utf8')));
  console.log(`${ref}: ${before.cross.size} and ${before.dict.size}`);
  const diff = (a, b) => [...a].filter(x => !b.has(x)).sort();
  const report = (label, list) => {
    console.log(`\n${label}: ${list.length}`);
    list.forEach(x => console.log('  ' + x));
  };
  report('NEW other-card acceptances', diff(now.cross, before.cross));
  report('NEW English-word acceptances', diff(now.dict, before.dict));
  report('no longer accepted (cards)', diff(before.cross, now.cross));
  report('no longer accepted (words)', diff(before.dict, now.dict));
}
console.log(`\n${Math.round((Date.now() - started) / 1000)}s`);
