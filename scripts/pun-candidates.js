// Finds the words whose reading is short enough to carry an English pun.
//
//   node scripts/pun-candidates.js            > candidates.tsv
//   node scripts/pun-candidates.js --sample 60
//
// The technique this serves: make one English word do both jobs at once. 誰 is
// "who" and reads だれ, and "who DARES say that" teaches the meaning and the
// reading in a single phrase, instead of telling a story and then appending the
// reading as a label. WaniKani do this throughout; Emaki's mnemonics mostly do
// not, and Lasz wants to know how much of the deck could.
//
// This script does not write puns. It cannot: judging whether an English word
// sounds like a Japanese reading AND can be bent towards the meaning needs
// phonetics and sense together, and there is no pronunciation dictionary on
// this machine. What it does is narrow 1500 words to the ones worth a model's
// attention, and give each a romaji form to think in.

const fs = require('fs');
const path = require('path');
const VOCAB = require(path.join(__dirname, '..', 'data', 'vocab.json'));

const DIGRAPHS = {
  'きゃ':'kya','きゅ':'kyu','きょ':'kyo','しゃ':'sha','しゅ':'shu','しょ':'sho',
  'ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo',
  'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','みゃ':'mya','みゅ':'myu','みょ':'myo',
  'りゃ':'rya','りゅ':'ryu','りょ':'ryo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
  'じゃ':'ja','じゅ':'ju','じょ':'jo','びゃ':'bya','びゅ':'byu','びょ':'byo',
  'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo'
};
const KANA = {
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
  'わ':'wa','を':'o','ん':'n',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  'ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o'
};

// Katakana sits in the same order one block up, so it converts by offset.
function toHiragana(s){
  return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function romaji(reading){
  const s = toHiragana(reading || '');
  let out = '', i = 0;
  while(i < s.length){
    const two = s.slice(i, i + 2);
    if(DIGRAPHS[two]){ out += DIGRAPHS[two]; i += 2; continue; }
    const c = s[i];
    if(c === 'っ'){                       // doubles the next consonant
      const nx = s.slice(i + 1, i + 3);
      const n = DIGRAPHS[nx] || KANA[s[i + 1]] || '';
      if(n) out += n[0];
      i++; continue;
    }
    if(c === 'ー'){ out += out.slice(-1); i++; continue; }
    out += (KANA[c] !== undefined ? KANA[c] : c);
    i++;
  }
  return out;
}

function morae(reading){
  return toHiragana(reading || '').replace(/[ぁぃぅぇぉゃゅょ]/g, '').length;
}

// Does the mnemonic already contain an English word that starts with the same
// sounds as the reading? A rough proxy for "the pun is already half there".
function alreadyPlaying(word){
  const r = romaji(word.reading);
  if(r.length < 3) return false;
  const stem = r.slice(0, 3);
  const words = (word.mnemonic || '').toLowerCase().match(/[a-z']+/g) || [];
  return words.some(w => w.length >= 3 && w.startsWith(stem));
}

const rows = VOCAB.map(v => ({
  id: v.id, word: v.word, meaning: v.meaning, reading: v.reading,
  romaji: romaji(v.reading), morae: morae(v.reading),
  latent: alreadyPlaying(v)
}));

const args = process.argv.slice(2);
const sampleAt = args.indexOf('--sample');

if(sampleAt >= 0){
  const n = Number(args[sampleAt + 1]) || 60;
  const pool = rows.filter(r => r.morae >= 1 && r.morae <= 3);
  // Evenly spaced through the deck rather than random, so the sample spans the
  // frequency ordering instead of clustering wherever a seed happens to land.
  const step = pool.length / n;
  const picked = [];
  for(let i = 0; i < n; i++) picked.push(pool[Math.floor(i * step)]);
  for(const r of picked){
    console.log([r.id, r.word, r.reading, r.romaji, r.meaning].join('\t'));
  }
  process.exit(0);
}

if(args.includes('--summary')){
  const n = rows.length;
  const short = rows.filter(r => r.morae <= 3).length;
  const latent = rows.filter(r => r.latent).length;
  const latentShort = rows.filter(r => r.latent && r.morae <= 3).length;
  console.log('words                          ' + n);
  console.log('reading of 1-3 morae           ' + short);
  console.log('  of those, already playing    ' + latentShort);
  console.log('reading of 4+ morae            ' + (n - short));
  console.log('mnemonics already playing      ' + latent);
  process.exit(0);
}

console.log(['id','word','reading','romaji','morae','latent','meaning'].join('\t'));
for(const r of rows) console.log([r.id,r.word,r.reading,r.romaji,r.morae,r.latent?1:0,r.meaning].join('\t'));
