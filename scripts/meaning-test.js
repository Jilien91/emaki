// Drives the real meaning grader out of app.js.
//
//   node scripts/meaning-test.js
//
// The grader has two ways to fail and they pull against each other. Too strict
// and a slip of the fingers costs a word its stage: "vasically" for つまり was
// marked wrong on 14 September 2026. Too loose and a different word passes as a
// typo, which is worse because nothing on screen says it happened. Every case
// here is one of those two, and most of them are pairs the comments in app.js
// were written about.
//
// The deck is the real one, because the word list that stops "rather" passing
// for "father" is built from it. Test items use a word no card has, so a
// single kanji's own meanings never join the accepted answers by accident.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const WANTED = ['levenshtein', 'splitSenses', 'meaningCandidates', 'openedSenses',
                'nextToOnKeyboard', 'isEnglishWord', 'americanSpelling', 'fuzzyMatch',
                'acceptedMeanings', 'stripParens', 'gradeMeaning', 'checkMeaning'];

// Pull a top-level `function name(` and everything to its matching brace.
function extract(name){
  const start = APP.indexOf('\nfunction ' + name + '(');
  if(start < 0) throw new Error('app.js has no top-level function ' + name);
  let i = APP.indexOf('{', start), depth = 0;
  for(; i < APP.length; i++){
    if(APP[i] === '{') depth++;
    else if(APP[i] === '}' && --depth === 0) return APP.slice(start + 1, i + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
// And a top-level declaration, to the end of its statement.
function extractDecl(prefix){
  const start = APP.indexOf('\n' + prefix);
  if(start < 0) throw new Error('app.js has no top-level ' + prefix);
  return APP.slice(start + 1, APP.indexOf(';', start) + 1);
}

const SOURCE = [extractDecl('const SPELLING_SWAPS'), extractDecl('const meaningCore'), extractDecl('let englishWords')]
  .concat(WANTED.map(extract)).join('\n\n');

const ctx = {
  VOCAB: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vocab.json'), 'utf8')),
  KANJI: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'kanji.json'), 'utf8')),
};
vm.createContext(ctx);
vm.runInContext(SOURCE, ctx);

let failures = 0;
function check(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if(!ok) failures++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name);
  if(!ok){
    console.log('        got  ' + JSON.stringify(got));
    console.log('        want ' + JSON.stringify(want));
  }
}

const RIGHT = { correct: true, typo: false };
const TYPO = { correct: true, typo: true };
const WRONG = { correct: false, typo: false };
const grade = (input, meaning) => {
  const r = ctx.gradeMeaning(input, meaning, { id: -1, word: 'テスト', meaning });
  return { correct: r.correct, typo: r.typo };
};

// ---- Right, and said to be right -------------------------------------------
check('an exact sense', grade('basically', 'in short, basically'), RIGHT);
check('the "to " left off is not a typo', grade('have', 'to have, to exist'), RIGHT);
check('the ellipsis left off is not a typo', grade('please give', 'please give...'), RIGHT);
check('a stored meaning copied with its brackets', grade('I (polite, general)', 'I (polite, general)'), RIGHT);
check('senses in another order', grade('basically, in short', 'in short, basically'), RIGHT);

// ---- Right, with the note ---------------------------------------------------
check('vasically: first letter on the key beside it', grade('vasically', 'in short, basically'), TYPO);
check('つまり itself, off the real card',
  (r => ({ correct: r.correct, typo: r.typo }))(ctx.gradeMeaning('vasically', 'in short, basically', ctx.VOCAB.find(v => v.id === 167))), TYPO);
check('a dropped letter, which was already accepted, now says so', grade('basicaly', 'in short, basically'), TYPO);
check('a transposition in a five-letter word', grade('hosue', 'house'), TYPO);
check('one typo inside a list of senses', grade('in shrot, basically', 'in short, basically'), TYPO);

// ---- The same word spelled the other way ------------------------------------
// Not typos, so no note: a spelling is not a slip. 24 September 2026.
check('favour is favor', grade('favour', 'favor'), RIGHT);
check('colour is color', grade('colour', 'color'), RIGHT);
check('honour is honor', grade('honour', 'to honor'), RIGHT);
check('centre is center', grade('centre', 'center'), RIGHT);
check('realise is realize', grade('realise', 'to realize'), RIGHT);
check('practise is practice', grade('practise', 'practice'), RIGHT);
check('the other direction too', grade('color', 'colour'), RIGHT);
check('a typo on top of a spelling is still a typo', grade('favuor', 'favor'), TYPO);

// ---- Wrong, and the reason each rule exists -------------------------------
check('mother is not father', grade('mother', 'father'), WRONG);
check('other is not mother', grade('other', 'mother'), WRONG);
check('rather is not father, though r is beside f', grade('rather', 'father'), WRONG);
check('horse is not house', grade('horse', 'house'), WRONG);
check('what is not that (彼)', grade('what', 'he, that'), WRONG);
check('three letters stay exact', grade('cst', 'cat'), WRONG);
check('how much is not (not) much', grade('how much', '(not) much'), WRONG);
check('a far-off first letter is not a slip', grade('masically', 'in short, basically'), WRONG);
check('a typo does not rescue a wrong second sense', grade('in shrot, cat', 'in short, basically'), WRONG);
check('four is not for: -our keeps its u when the word is short', grade('four', 'for'), WRONG);
check('flavour is still not favor', grade('flavour', 'favor'), WRONG);
check('hour is not honor', grade('hour', 'honor'), WRONG);
check('checkMeaning still answers yes or no', ctx.checkMeaning('vasically', 'in short, basically', null), true);

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
