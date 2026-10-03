// Builds a public page for every word in the deck.
//
//   node scripts/gen-word-pages.js
//
// Why these exist: being found. Posting about Emaki depends on somebody else's
// self-promotion rules, and the r/Anki post was removed for being about an app
// rather than about Anki. A page per word depends on nobody. Somebody types
// "調べる mnemonic" at eleven at night and gets the thing they asked for.
//
// Generated, committed, and served as static files, the same arrangement as the
// audio: nothing new runs at request time, and the no-build-step rule still
// holds for what ships.
//
// WHAT THESE PAGES DO NOT CARRY: Kaishi's example sentences. The permission
// covers six fields and the app uses all six, but a sentence is written by
// somebody, and a page indexed by Google is republishing rather than studying.
// Word, reading and meaning are facts; the mnemonic, the note and the kanji
// breakdown are ours. Lasz's call, 3 October 2026.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://emakisrs.com';
const OUT = path.join(ROOT, 'word');

const VOCAB = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vocab.json'), 'utf8'));
const KANJI = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/kanji.json'), 'utf8'));
const AUDIO = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audio.json'), 'utf8'));

const audioIds = new Set((AUDIO.ids && AUDIO.ids.f) || []);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A word is its own slug, except where two cards share one. 人 is both ひと and
// じん, and a page that silently replaced the other would lose half the pair.
const seen = {};
VOCAB.forEach(w => { seen[w.word] = (seen[w.word] || 0) + 1; });
const slugOf = w => (seen[w.word] > 1 ? w.word + '-' + w.id : w.word);
const urlOf = w => SITE + '/word/' + encodeURIComponent(slugOf(w)) + '/';

// ---- Indexes behind the internal links --------------------------------------
const byReading = {};
const byKanji = {};
VOCAB.forEach(w => {
  (byReading[w.reading] = byReading[w.reading] || []).push(w);
  Array.from(w.word).forEach(c => {
    if (KANJI[c]) (byKanji[c] = byKanji[c] || []).push(w);
  });
});

const link = w => '<a class="wlink" href="/word/' + encodeURIComponent(slugOf(w)) + '/">'
  + '<span class="jp">' + esc(w.word) + '</span> <span class="gloss">' + esc(w.meaning) + '</span></a>';

function kanjiSection(w) {
  const chars = Array.from(w.word).filter(c => KANJI[c]);
  if (!chars.length) return '';
  const rows = chars.map(c => {
    const k = KANJI[c];
    const parts = (k.parts || []).map(p => esc(p.c) + ' ' + esc(p.name)).join(' + ');
    return `<div class="krow">
      <div class="kchar jp">${esc(c)}</div>
      <div class="kbody">
        <div class="kmean">${esc(k.meaning)}</div>
        ${parts ? `<div class="kparts">${parts}</div>` : ''}
        ${k.note ? `<div class="knote">${esc(k.note)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<h2>Built from</h2>${rows}`;
}

function relatedSection(w) {
  const sameReading = (byReading[w.reading] || []).filter(o => o.id !== w.id);
  const sameKanji = [];
  Array.from(w.word).forEach(c => {
    (byKanji[c] || []).forEach(o => {
      if (o.id !== w.id && !sameReading.includes(o) && !sameKanji.includes(o)) sameKanji.push(o);
    });
  });
  let out = '';
  if (sameReading.length) {
    out += `<h2>Also read ${esc(w.reading)}</h2><div class="wlinks">${sameReading.slice(0, 8).map(link).join('')}</div>`;
  }
  if (sameKanji.length) {
    out += `<h2>Words sharing these kanji</h2><div class="wlinks">${sameKanji.slice(0, 12).map(link).join('')}</div>`;
  }
  return out;
}

const PAGE_CSS = `  .doc{max-width:720px;margin:0 auto;padding:24px 20px 60px;}
  .crumb{font-size:12px;color:var(--text-faint);margin:0 0 18px;}
  .crumb a{color:var(--text-dim);}
  h1{font-size:28px;margin:0 0 4px;}
  h1.jp{font-size:46px;line-height:1.15;}
  .reading{font-size:20px;color:var(--text-dim);margin:0 0 2px;}
  .meaning{font-size:17px;color:var(--text);margin:0 0 16px;}
  .doc h2{font-size:13px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text);margin:26px 0 8px;}
  .doc p,.doc li{color:var(--text-dim);line-height:1.65;font-size:14px;}
  .mnem{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
  .note{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px;}
  .krow{display:flex;gap:14px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);
    border-radius:12px;padding:12px 14px;margin-bottom:8px;}
  .kchar{font-size:32px;line-height:1;}
  .kmean{color:var(--text);font-size:14px;}
  .kparts,.knote{color:var(--text-dim);font-size:13px;margin-top:3px;}
  .wlinks{display:flex;flex-wrap:wrap;gap:8px;}
  .wlink{display:inline-flex;align-items:baseline;gap:7px;text-decoration:none;background:var(--surface);
    border:1px solid var(--border);border-radius:10px;padding:7px 11px;}
  .wlink:hover{border-color:var(--border-strong);}
  .wlink .jp{font-size:16px;color:var(--text);}
  .wlink .gloss{font-size:12px;color:var(--text-faint);}
  .cta{margin-top:30px;background:var(--surface);border:1px solid var(--border-strong);border-radius:14px;padding:18px;}
  .cta a{color:var(--text);}
  /* The app's own primary button, as a link: the stylesheet styles button.primary
     by element, and this is an anchor. Same shape, same weight. */
  .gobtn{display:block;text-align:center;padding:13px;border-radius:10px;background:var(--text);
    color:var(--bg);font-weight:600;font-size:14px;text-decoration:none;}
  .gobtn:hover{opacity:0.9;}
  .foot{margin-top:28px;font-size:12px;color:var(--text-faint);line-height:1.6;}
  .foot a{color:var(--text-dim);}
  audio{width:100%;margin-top:10px;}`;

function shell(opts) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${opts.canonical}">
<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Emaki">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${opts.canonical}">
<meta property="og:image" content="${SITE}/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/style.css">
<script>
  try{
    var saved = JSON.parse(localStorage.getItem('kaishi-settings') || '{}').theme || 'system';
    var light = saved === 'light' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    if(light) document.documentElement.setAttribute('data-theme', 'light');
  }catch(e){}
</script>
${opts.jsonld ? `<script type="application/ld+json">${opts.jsonld}</script>` : ''}
<style>
${PAGE_CSS}
</style>
</head>
<body>
<div class="doc">
${opts.body}
</div>
</body>
</html>
`;
}

function wordPage(w) {
  const title = `${w.word} (${w.reading}): meaning and mnemonic · Emaki`;
  const description = `${w.word} means ${w.meaning}, read ${w.reading}. A written mnemonic to remember it by, the kanji it is built from, and audio.`;
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: w.word,
    alternateName: w.reading,
    description: w.meaning,
    inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Emaki, the Kaishi 1.5k deck with mnemonics', url: SITE + '/word/' },
    url: urlOf(w)
  });
  const audio = audioIds.has(w.id)
    ? `<audio controls preload="none" src="/audio/f/${w.id}.mp3">Your browser cannot play this audio.</audio>` : '';
  const body = `  <p class="crumb"><a href="/">Emaki</a> · <a href="/word/">all 1,500 words</a></p>
  <h1 class="jp">${esc(w.word)}</h1>
  <p class="reading">${esc(w.reading)}</p>
  <p class="meaning">${esc(w.meaning)}</p>
  ${audio}
  <h2>Mnemonic</h2>
  <div class="mnem"><p style="margin:0;">${esc(w.mnemonic)}</p></div>
  ${w.notes && w.notes.trim() ? `<h2>Worth knowing</h2><div class="note"><p style="margin:0;">${esc(w.notes)}</p></div>` : ''}
  ${kanjiSection(w)}
  ${relatedSection(w)}
  <div class="cta">
    <p style="margin:0 0 12px;color:var(--text);">This is one of 1,500 words in Emaki, a free spaced repetition trainer with a written mnemonic on every card.</p>
    <a class="gobtn" href="/#word-${w.id}">Open ${esc(w.word)} in Emaki</a>
    <p style="margin:10px 0 0;font-size:12px;">Free, no account needed. Your progress stays in your browser.</p>
  </div>
  <p class="foot"><b>Emaki is not affiliated with, or endorsed by, Kaishi 1.5k or its authors.</b>
  The word, reading and meaning come from the
  <a href="https://github.com/donkuri/Kaishi" target="_blank" rel="noopener noreferrer">Kaishi 1.5k</a> deck,
  used with their permission. The mnemonic, the note and the kanji breakdown are original work, published
  under CC BY-SA 4.0.</p>`;
  return shell({ title, description, canonical: urlOf(w), jsonld, body });
}

// ---- The index, which is what ties 1,500 pages together for a crawler -------
const KANA_ROWS = [
  ['あ', 'あいうえお'], ['か', 'かきくけこがぎぐげご'], ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでど'], ['な', 'なにぬねの'], ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'], ['や', 'やゆよ'], ['ら', 'らりるれろ'], ['わ', 'わをん']
];

function indexPage() {
  const sorted = VOCAB.slice().sort((a, b) => a.reading.localeCompare(b.reading, 'ja'));
  const used = new Set();
  const groups = KANA_ROWS.map(([label, chars]) => {
    const words = sorted.filter(w => chars.includes(w.reading[0]));
    words.forEach(w => used.add(w.id));
    if (!words.length) return '';
    return `<h2>${label}</h2><div class="wlinks">${words.map(link).join('')}</div>`;
  }).join('');
  const rest = sorted.filter(w => !used.has(w.id));
  const other = rest.length ? `<h2>Other</h2><div class="wlinks">${rest.map(link).join('')}</div>` : '';
  const body = `  <p class="crumb"><a href="/">Emaki</a></p>
  <h1>All 1,500 words</h1>
  <p class="meaning">Every word in the deck, with its meaning, a written mnemonic, and the kanji it is built from. Ordered by reading.</p>
  ${groups}${other}
  <div class="cta">
    <p style="margin:0 0 10px;color:var(--text);">Emaki is a free spaced repetition trainer for these 1,500 words, with a mnemonic on every card.</p>
    <p style="margin:0;"><a href="/">Study the deck</a></p>
  </div>
  <p class="foot"><b>Emaki is not affiliated with, or endorsed by, Kaishi 1.5k or its authors.</b>
  The word list comes from the <a href="https://github.com/donkuri/Kaishi" target="_blank" rel="noopener noreferrer">Kaishi 1.5k</a>
  deck, used with their permission. The mnemonics and kanji breakdowns are original work, CC BY-SA 4.0.</p>`;
  return shell({
    title: 'All 1,500 words, with mnemonics · Emaki',
    description: 'Every word in the Kaishi 1.5k deck with its meaning, reading, a written mnemonic and a kanji breakdown. Free, no account needed.',
    canonical: SITE + '/word/',
    body
  });
}

// ---- Write -------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

VOCAB.forEach(w => {
  const dir = path.join(OUT, slugOf(w));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), wordPage(w));
});
fs.writeFileSync(path.join(OUT, 'index.html'), indexPage());

const urls = [SITE + '/', SITE + '/word/', SITE + '/privacy/', SITE + '/terms/'].concat(VOCAB.map(urlOf));
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map(u => '  <url><loc>' + u.replace(/&/g, '&amp;') + '</loc><lastmod>' + today + '</lastmod></url>').join('\n')
  + '\n</urlset>\n');

fs.writeFileSync(path.join(ROOT, 'robots.txt'),
  'User-agent: *\nAllow: /\n\nSitemap: ' + SITE + '/sitemap.xml\n');

console.log('wrote ' + VOCAB.length + ' word pages, the index, sitemap.xml and robots.txt');
