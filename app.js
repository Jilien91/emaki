// The app is called Emaki, but every localStorage key below keeps the old
// kaishi- prefix on purpose. They are how existing installs find their
// progress, and renaming them would silently orphan every user's history
// including your own. Leave them alone unless you also ship a migration that
// copies the old keys across first.
const STORAGE_KEY = 'kaishi-progress';
const SETTINGS_KEY = 'kaishi-settings';
const DAILY_KEY = 'kaishi-daily-lessons';
const MISTAKES_KEY = 'kaishi-mistakes';
const ACTIVITY_KEY = 'kaishi-activity';
const REVIEW_HISTORY_KEY = 'kaishi-review-history';
const DEFAULT_SETTINGS = {
  dailyNewLimit: 20,        // 0 = unlimited
  lessonBatchSize: 5,
  reviewOrder: 'shuffled',  // 'shuffled' | 'genin-first' | 'lower-stage-first'
  showSrsIndicator: true,
  speechRate: 0.8,          // device voices are hard to follow above this
  voiceName: null,          // null = pick one automatically; see pickJapaneseVoice
  audioVoice: null,         // which shipped voice set to play; null = the first there is
  autoPlayLessonAudio: true,
  hideAnswerOnMistake: true, // make yourself recall it before it's handed over
  showMnemonicOnAnswer: false, // the mnemonic gives away the half you haven't been asked yet
  theme: 'system',           // 'system' | 'light' | 'dark'
  palette: 'classic',        // which colours; see PALETTES
  // null rather than a copy of the shipped order, so that a later version can
  // change the default and everybody who never arranged anything gets it. Both
  // are read through dashboardLayout() and dashboardHiddenIds(), which is where
  // an unknown or missing section id is dealt with.
  dashboardOrder: null,      // [sectionId, ...]; null = the order in DASHBOARD_SECTIONS
  dashboardHidden: null      // [sectionId, ...]; null = nothing hidden
};
const STREAK_SAVE_KEY = 'kaishi-streak-saves';
const SYNC_PROMPT_KEY = 'kaishi-sync-prompt-dismissed';
// One kunai in hand at a time, replenishing every 3 days. A missed day spends
// it and the streak carries on; miss two in a row and it breaks.
const STREAK_SAVE_MAX = 1;
const STREAK_SAVE_DAYS = 3;
// iOS capitalises the first letter of a text field by default, and wanakana
// maps uppercase romaji to katakana on purpose, so "Watashi" could come out
// starting ワ. Grading survives it (checkReading runs toHiragana), but the box
// looked wrong while typing. autocorrect and spellcheck are off for the same
// family of reasons: predictive text mangles romaji.
const ANSWER_INPUT_ATTRS =
  'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"';
const MISTAKE_WINDOW_MS = 24*3600*1000;
// Most-recent misses shown as tiles; the rest collapse into a "+N" chip so a
// bad day doesn't turn the dashboard into a wall. Extra Study still drills
// every one of them.
const MISTAKE_TILE_LIMIT = 30;
const STAGE_NAMES = ['New','Genin 1','Genin 2','Genin 3','Genin 4','Chunin 1','Chunin 2','Jonin','Anbu','Kage'];
const INTERVAL_HOURS = [null,4,8,23,47,168,336,720,2880,null];
const TIER_COLOR = s => s===0?'new':s<=4?'genin':s<=6?'chunin':s===7?'jonin':s===8?'anbu':'kage';

let VOCAB = [];
let KANJI = {}; // char -> {meaning, parts:[{c,name}], note}
let progress = {};
let settings = { ...DEFAULT_SETTINGS };
let dailyLessons = { date: null, count: 0 };
let mistakes = []; // [{id, type:'meaning'|'reading', timestamp}]
let activityDates = []; // ['YYYY-MM-DD', ...]
let streakSaves = { count: STREAK_SAVE_MAX, lastEarned: null, savedDates: [] };
let reviewHistory = {}; // {'YYYY-MM-DD': count}
let storageOk = true;
let view = 'dashboard';
// A CSS selector for whatever should hold the focus after the next render, set
// by a handler that knows a redraw is about to take the focus away from it.
let focusAfterRender = null;
let sessionCorrect = 0;
let sessionTotal = 0;
let lessonState = null; // {batch, phase:'study'|'quiz', studyIndex, showAnswer, quizQueue, quizProgress, lastCorrect, lastInput}
// {queue:[{id,type}], results:{id:{meaning,reading,missed}}, showAnswer, lastCorrect, lastInput}
let reviewState = null;
let extraStudyState = null; // {queue:[{id,type}], index, showAnswer, lastCorrect, lastInput}

// Escapes for both text and attribute contexts. Quotes matter because some
// entries contain them (e.g. a sentence gloss with "He does tennis"), and an
// unescaped one would terminate a title="..." attribute early. Quote
// replacement runs after the element-based escaping so the ampersands it
// introduces aren't escaped a second time.
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Damerau-Levenshtein: an adjacent transposition costs 1 rather than the 2 a
// plain edit distance charges. Transposing two letters is the commonest typo
// there is, and counting it double is what forced the old threshold up high
// enough to start accepting different words.
function levenshtein(a, b){
  const m = a.length, n = b.length;
  if(m===0) return n;
  if(n===0) return m;
  const dp = [];
  for(let i=0;i<=m;i++) dp[i] = [i];
  for(let j=0;j<=n;j++) dp[0][j] = j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
      if(i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]){
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2]+1);
      }
    }
  }
  return dp[m][n];
}

// Senses are comma separated, but a comma inside brackets belongs to the note
// rather than to the list: "I (polite, general)" is one sense, not two.
function splitSenses(s){
  return s.split(/[,/](?![^(]*\))/).map(t=>t.trim()).filter(Boolean);
}

// Meanings like "I (polite, general)" or "he, him" can have several
// acceptable answers, split out synonyms and drop parenthetical notes.
function meaningCandidates(meaning){
  const stripped = meaning.replace(/\([^)]*\)/g, '').trim();
  const source = stripped || meaning;
  const candidates = source.split(/[,/]/).map(s=>s.trim().toLowerCase()).filter(Boolean);
  candidates.push(meaning.trim().toLowerCase());
  return candidates;
}

// A bracket at the front of a sense is part of the sense: "(not) very" is read
// as "not very" and gets typed that way, so accept it unwrapped. A bracket at
// the end is a note about register instead, and unwrapping "I (polite,
// general)" would accept "general" for 私, so only leading ones open.
//
// These match exactly, never fuzzily. They are short qualifier phrases, and
// fuzzyMatch allows two edits at eight characters, which is the whole distance
// from "not much" to "how much" and from "the most" to "the past".
function openedSenses(meaning){
  const out = [];
  for(const sense of splitSenses(meaning)){
    if(!sense.startsWith('(')) continue;
    const opened = sense.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if(opened && !out.includes(opened)) out.push(opened);
  }
  return out;
}

// Nearly every verb in the deck is glossed "to X", so a typo budget taken from
// the whole string spends itself on boilerplate every gloss shares. "to have"
// is seven characters and looks roomy, but only four of them carry any meaning,
// and one substitution inside those four reaches save, wave, gave, take, give
// and move. The budget therefore comes from the distinguishing part.
//
// Under the old rule 彼 "he, that" accepted "what", because what is one edit
// from that, and いる "to have, to exist" accepted six other verbs in the deck.
// 766 such acceptances existed across the written cards.
// Normalisation before any comparison. The "to " is a convention of the deck's
// glosses rather than part of the answer, and so is a leading or trailing
// ellipsis: "please give..." means the verb takes an object, not that the dots
// are part of the word.
//
// The dots used to count as typos. Against "please give..." the answer "please
// give" scored three edits on a budget of two and was marked wrong, and so was
// "please give, please do", which is both senses stated correctly. The only
// answer the card accepted was one that reproduced the punctuation. 13 cards
// carry an ellipsis in their meaning.
//
// The typo budget is untouched, but this is not free of consequences: removing
// the dots can expose a genuine overlap between two glosses that the
// punctuation had been hiding. "well..." for まあ becomes "well", which よく
// also is. The cross-acceptance audit tracks those, and the cards concerned say
// which is which rather than the grader pretending they are different.
const meaningCore = s => s
  .replace(/^to /, '')
  .replace(/\.\.\.|…/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function fuzzyMatch(input, candidate){
  if(input === candidate) return true;
  // The "to " is a convention of the deck's glosses, not part of the answer.
  if(meaningCore(input) === meaningCore(candidate)) return true;
  const ci = meaningCore(input), cc = meaningCore(candidate);
  const len = cc.length;
  if(len <= 5) return false; // short enough that a typo isn't worth guessing at
  // A slip of the fingers almost never lands on the first letter, while the
  // pairs that need keeping apart routinely differ only there: father and
  // mother, mother and other, rather and father are each one edit apart.
  if(ci[0] !== cc[0]) return false;
  // Compare the cores, so dropping the "to " and fumbling a letter is one
  // deviation rather than four.
  return levenshtein(ci, cc) <= (len <= 9 ? 1 : 2);
}

// A single-kanji word inherits its kanji's meanings as acceptable answers, so a
// mnemonic that teaches 本 as "the origin a thing grows from" doesn't then mark
// "origin" wrong. Skipped where the same character backs more than one entry
// (方 is both ほう "direction" and かた "person"), since there the other
// meaning belongs to a different card and accepting it would be a free pass.
function acceptedMeanings(meaning, item){
  const list = meaningCandidates(meaning);
  if(!item) return list;
  const chars = Array.from(item.word);
  if(chars.length === 1 && KANJI[chars[0]] && VOCAB.filter(v=>v.word===item.word).length === 1){
    meaningCandidates(KANJI[chars[0]].meaning).forEach(m=>{ if(!list.includes(m)) list.push(m); });
  }
  return list;
}

function stripParens(s){
  return s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function checkMeaning(userInput, meaning, item){
  const whole = userInput.trim().toLowerCase().replace(/\s+/g, ' ');
  if(!whole) return false;
  const correctCandidates = acceptedMeanings(meaning, item);
  const opened = openedSenses(meaning);
  const hit = s => opened.includes(s) || correctCandidates.some(c => fuzzyMatch(s, c));
  // Try the whole answer first. This is what accepts an exact copy of a
  // stored meaning whose own parentheses contain commas, e.g. typing
  // "I (polite, general)". Splitting that on commas would match nothing.
  if(hit(whole)) return true;
  // meaningCandidates drops parentheticals from the stored meaning but nothing
  // dropped them from the answer, so "(not) very" was marked wrong against
  // "(not) very, (not) much" while a bare "very" passed. Copying the card back
  // faithfully has to be at least as right as typing half of it.
  const bare = stripParens(whole);
  if(bare && bare !== whole && hit(bare)) return true;
  // Otherwise treat it as a list of synonyms, so "like, fond of" is accepted
  // for "fond of, liked". Every part must be a valid synonym. That keeps
  // "he, cat" from passing for "he, him" on the strength of "he" alone. Order
  // never mattered here and still doesn't: the senses are a set, so "(not)
  // much, (not) very" is the same answer as "(not) very, (not) much".
  const parts = splitSenses(whole).map(s => stripParens(s)).filter(Boolean);
  if(parts.length < 2) return false;
  return parts.every(hit);
}

function checkReading(userInput, reading){
  const raw = userInput.trim();
  const input = window.wanakana ? window.wanakana.toHiragana(raw) : raw;
  return reading.split('・').map(s=>s.trim()).includes(input);
}

// sync.js is optional, if it failed to load (offline, CDN blocked, or the
// user never set sync up) the app must carry on as a local-only tool.
function flagSync(){ if(typeof markDirty === 'function') markDirty(); }

// ---- Speech ---------------------------------------------------------------
// Audio comes from the browser's own Japanese voice rather than shipped files.
//
// Parked on 9 August 2026 and back on 18 August, with the fix that was noted
// when it was parked. Handing the synthesiser a bare kanji made it guess the
// reading, and it guessed by frequency rather than by what the card teaches:
// 人 came out as ひと on a card teaching じん. So nothing hands it a kanji any
// more. speakWord says item.reading, which is kana and cannot be misread, and
// the default rate dropped to 0.8 because the device voices are hard to follow
// faster than that.
//
// Word audio only. The example sentences have no kana anywhere in the data, so
// speaking one means handing over kanji again and hoping context saves it, which
// is the bug this feature was parked for. speakSentence is left below, unwired,
// for if a reading ever gets added for the sentences.
const AUDIO_ENABLED = true;

let jaVoice = null;

function speechSupported(){
  return AUDIO_ENABLED
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

// Voices load asynchronously in most browsers, so this is re-run on the
// voiceschanged event as well as at startup.
function pickJapaneseVoice(){
  if(!speechSupported()) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const ja = voices.filter(v => (v.lang||'').toLowerCase().replace('_','-').startsWith('ja'));
  if(ja.length===0){ jaVoice = null; return null; }
  // A chosen voice wins over the guess below. Matched by name because that is
  // the only stable identifier the API gives, and missing the match is fine:
  // settings sync between devices, and a voice installed on one is not
  // installed on the next, so it falls through to the automatic pick.
  const chosen = settings.voiceName && ja.find(v => v.name === settings.voiceName);
  if(chosen){ jaVoice = chosen; return jaVoice; }
  // Failing that, prefer a voice the platform marks as local: network voices
  // cut out offline and lag behind the tap that triggered them. This is a
  // safety-first default and not a quality judgement — on Windows the local
  // one is usually the older, flatter voice, and the good neural voices are
  // the network ones. Hence the picker in settings.
  jaVoice = ja.find(v=>v.localService) || ja[0];
  return jaVoice;
}

// Every Japanese voice the device exposes, for the settings picker.
function japaneseVoices(){
  if(!speechSupported()) return [];
  return (window.speechSynthesis.getVoices() || [])
    .filter(v => (v.lang||'').toLowerCase().replace('_','-').startsWith('ja'));
}

// Auditioning is the whole point of the picker, so this applies and saves the
// choice as soon as it changes and speaks a sample in the new voice. No
// re-render: that would rebuild the select and throw away the open dropdown.
function auditionVoice(name){
  settings.voiceName = name || null;
  pickJapaneseVoice();
  saveSettings();
  speakJa('にほんごをべんきょうしています。');
}

// Same reasoning as auditionVoice: picking between two voices is something you
// do by ear, so apply and play rather than making Save the moment it takes
// effect. No re-render, which would close the open dropdown.
function chooseShippedVoice(key){
  if(!AUDIO_IDS[key]) return;
  settings.audioVoice = key;
  saveSettings();
  const anyShipped = AUDIO_IDS[key];
  if(anyShipped.size) speakWord(Math.min(...anyShipped));
}

// The settings sample should be the thing being configured. Once audio ships
// with the app, a synthesised phrase would be demonstrating the fallback rather
// than what the user is actually going to hear.
function playAudioSample(){
  const anyShipped = Object.values(AUDIO_IDS).find(s=>s.size);
  if(anyShipped){
    speakWord(Math.min(...anyShipped));
    return;
  }
  speakJa('にほんごをべんきょうしています。');
}

function initSpeech(){
  if(!speechSupported()) return;
  pickJapaneseVoice();
  window.speechSynthesis.onvoiceschanged = ()=>{
    const had = !!jaVoice;
    pickJapaneseVoice();
    // The audio buttons are hidden until a voice exists, so repaint once one
    // turns up, otherwise they'd stay hidden until the next navigation.
    if(!had && jaVoice && document.getElementById('root')) render();
  };
}

function canSpeak(){ return speechSupported() && !!jaVoice; }

function speakJa(text){
  if(!canSpeak() || !text) return;
  try{
    window.speechSynthesis.cancel(); // don't queue up behind a previous tap
    const u = new SpeechSynthesisUtterance(text);
    u.voice = jaVoice;
    u.lang = jaVoice.lang || 'ja-JP';
    u.rate = settings.speechRate;
    window.speechSynthesis.speak(u);
  }catch(e){ /* speech is a nicety; never let it break a review */ }
}

// ---- Shipped audio --------------------------------------------------------
// Generated once by scripts/gen-audio.pl and served as files, so the audio does
// not depend on what the device has installed. Every user hears the same thing
// and nobody is asked to go and install a voice before they can study.
//
// Two voices, keyed f and m, each with its own id set: audio/f/<id>.mp3. Both
// empty is the normal state until that script has been run, and everything
// below then falls through to the device voice exactly as before.
let AUDIO_VOICES = [];              // [{key,label,azure,count}]
let AUDIO_IDS = {};                 // {f: Set, m: Set}

// Which set to play. The preferred voice wins, but a word only generated in the
// other one still plays rather than dropping to the synthesiser: a half-done
// run should sound inconsistent, not broken.
function audioSrc(id){
  const pref = settings.audioVoice;
  if(pref && AUDIO_IDS[pref] && AUDIO_IDS[pref].has(id)) return `audio/${pref}/${id}.mp3`;
  for(const key of Object.keys(AUDIO_IDS)){
    if(AUDIO_IDS[key].has(id)) return `audio/${key}/${id}.mp3`;
  }
  return null;
}

function hasWordAudio(id){ return audioSrc(id) !== null; }
function shippedAudioCount(){
  return Object.values(AUDIO_IDS).reduce((n, s)=>Math.max(n, s.size), 0);
}

// Returns true if playback started. The caller falls back to the synthesiser on
// false, which covers a missing file, a decode failure and autoplay refusal
// alike: any of them should leave the user with audio rather than silence.
function playWordAudio(id){
  const src = audioSrc(id);
  if(!src) return false;
  try{
    const a = new Audio(src);
    // The speed setting should mean the same thing whichever source is playing.
    // preservesPitch matters more here than usual: pitch accent is part of what
    // the card teaches, so slowing a word down must not transpose it.
    a.preservesPitch = true;
    a.playbackRate = settings.speechRate;
    a.play().catch(()=>{ speakJa(spokenReading(id)); });
    return true;
  }catch(e){ return false; }
}

// The reading, not the word: kana leaves the synthesiser nothing to guess at.
// Three cards carry two readings separated by ・ (何 なに・なん, 四 よん・し,
// 七 なな・しち) and the first is the one the card teaches in each, which is
// also the one the notes tell you to prefer, so take that and don't read the
// separator out loud. scripts/gen-audio.pl picks the text the same way; if the
// two ever disagree the audio starts teaching a reading the card does not.
function spokenReading(id){
  const item = VOCAB.find(v=>v.id===id);
  return item ? item.reading.split('・')[0].trim() : '';
}

function speakWord(id){
  if(playWordAudio(id)) return;
  speakJa(spokenReading(id));
}
// Deliberately not wired to anything: see the note on AUDIO_ENABLED. Speaking a
// sentence means handing raw kanji over, which is what got the feature parked.
// Kept for whenever the data carries a reading for the sentences too.
function speakSentence(id){
  const item = VOCAB.find(v=>v.id===id);
  if(item) speakJa(item.sentence);
}

// Small speaker button. Shipped audio is enough on its own, so this no longer
// requires a Japanese voice to be installed — only that one of the two sources
// can actually produce a sound.
function audioBtn(fn, id, label){
  if(!hasWordAudio(id) && !canSpeak()) return '';
  return `<button class="audio-btn" onclick="event.stopPropagation();${fn}(${id})" title="${label}" aria-label="${label}">🔊</button>`;
}

function loadProgress(){
  try{
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if(raw){ progress = JSON.parse(raw); }
    storageOk = true;
  }catch(e){
    storageOk = false;
  }
}

function saveProgress(){
  try{
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    storageOk = true;
  }catch(e){
    storageOk = false;
  }
  flagSync();
}

function loadSettings(){
  try{
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if(raw){ settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)); }
  }catch(e){}
}

// Which theme is actually in force. "system" is resolved here rather than in
// CSS: a prefers-color-scheme block would mean writing the whole light palette
// out twice, once for the media query and once for the explicit choice, and
// the two copies would drift.
function resolvedTheme(){
  const t = settings.theme || 'system';
  if(t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

// ---- Palettes ---------------------------------------------------------------
//
// Two independent choices, not one list of eight. The palette says which
// colours; light and dark says which end of that palette. Every palette states
// both, so switching one never disturbs the other, and somebody who follows the
// system clock still gets whichever palette they picked at either end of the day.
//
// `skin` is what the palette is made of rather than what colour it is. Four of
// these are paper and want the fibre, the stains and the serif numerals; Classic
// is not and wants none of it. style.css keys that off data-skin.
//
// bg is repeated here from the CSS because theme-color is set on a meta tag
// rather than read from a stylesheet, and the browser chrome not matching the
// page is the most visible thing on a phone.
const PALETTES = [
  { id:'classic', label:'Classic', skin:'plain', accent:'#4fa8e0',
    bg:{ dark:'#15171c', light:'#f2f3f6' } },
  { id:'ember',   label:'Ember',   skin:'paper', accent:'#e60012',
    bg:{ dark:'#070605', light:'#c9b391' } },
  { id:'indigo',  label:'Indigo',  skin:'paper', accent:'#2f5d8c',
    bg:{ dark:'#05070a', light:'#a9b6c4' } },
  { id:'slate',   label:'Slate',   skin:'paper', accent:'#357f77',
    bg:{ dark:'#08090a', light:'#b0b5b8' } },
  { id:'plum',    label:'Plum',    skin:'paper', accent:'#b0455f',
    bg:{ dark:'#08050a', light:'#bfa8b6' } }
];

// An id from a newer version, or a corrupted settings blob, must not leave the
// app with no palette at all.
function currentPalette(){
  return PALETTES.find(p => p.id === settings.palette) || PALETTES[0];
}

function applyTheme(){
  const t = resolvedTheme();
  const p = currentPalette();
  const root = document.documentElement;
  root.dataset.theme = t;
  root.dataset.palette = p.id;
  root.dataset.skin = p.skin;
  // Tells the browser what the page already is, so its own darkening stays out
  // of the way. Not a guarantee everywhere: Firefox on iOS injects its night
  // mode as a user script and does not consult this.
  root.style.colorScheme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', p.bg[t]);
}

// Only while the setting is "system"; an explicit choice should not move when
// the operating system does.
function watchSystemTheme(){
  if(!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if((settings.theme || 'system') === 'system') applyTheme(); };
  if(mq.addEventListener) mq.addEventListener('change', onChange);
  else if(mq.addListener) mq.addListener(onChange);
}

function saveSettings(){
  try{ window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
  flagSync();
}

function dateKey(d){
  d = d || new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function todayKey(){ return dateKey(); }

// Step whole calendar days. Subtracting 86400000ms is not equivalent: on a
// DST changeover day it can land back on the same date (verified in
// Europe/London on 2026-10-25), which would double-count a streak day and
// make "yesterday" resolve to today.
function addDays(d, n){
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function loadDailyLessons(){
  try{
    const raw = window.localStorage.getItem(DAILY_KEY);
    if(raw){ dailyLessons = JSON.parse(raw); }
  }catch(e){}
  if(dailyLessons.date !== todayKey()){ dailyLessons = { date: todayKey(), count: 0 }; }
}

function saveDailyLessons(){
  try{ window.localStorage.setItem(DAILY_KEY, JSON.stringify(dailyLessons)); }catch(e){}
  flagSync();
}

function incrementDailyLessons(){
  if(dailyLessons.date !== todayKey()){ dailyLessons = { date: todayKey(), count: 0 }; }
  dailyLessons.count++;
  saveDailyLessons();
}

function remainingToday(){
  if(settings.dailyNewLimit === 0) return Infinity;
  return Math.max(0, settings.dailyNewLimit - dailyLessons.count);
}

// Preferred batch size, bumped up when it would otherwise leave a small
// leftover batch (e.g. preferred 5, 7 pending -> do all 7, not 5 then 2).
function plannedLessonBatchSize(){
  const avail = Math.min(newWords().length, remainingToday());
  const preferred = settings.lessonBatchSize;
  if(avail <= preferred) return avail;
  const leftover = avail - preferred;
  return leftover < preferred ? avail : preferred;
}

function loadMistakes(){
  try{
    const raw = window.localStorage.getItem(MISTAKES_KEY);
    if(raw){ mistakes = JSON.parse(raw); }
  }catch(e){}
  pruneMistakes();
}

function saveMistakes(){
  try{ window.localStorage.setItem(MISTAKES_KEY, JSON.stringify(mistakes)); }catch(e){}
  flagSync();
}

function pruneMistakes(){
  const cutoff = now() - MISTAKE_WINDOW_MS;
  mistakes = mistakes.filter(m=>m.timestamp>=cutoff);
}

function recordMistake(id, type){
  mistakes.push({id, type: type || 'meaning', timestamp: now()});
  saveMistakes();
}

// Words missed in the last 24h, most recent first. A word is one mistake
// whichever half of it you got wrong. Meaning and reading are two halves of
// the same item, not two separate things to get wrong.
function recentMistakeIds(){
  pruneMistakes();
  const seen = new Set();
  const result = [];
  for(let i=mistakes.length-1;i>=0;i--){
    if(!seen.has(mistakes[i].id)){ seen.add(mistakes[i].id); result.push(mistakes[i].id); }
  }
  return result;
}

function loadActivity(){
  try{
    const raw = window.localStorage.getItem(ACTIVITY_KEY);
    if(raw){ activityDates = JSON.parse(raw); }
  }catch(e){}
}

function saveActivity(){
  try{ window.localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activityDates)); }catch(e){}
  flagSync();
}

function recordActivityToday(){
  const k = todayKey();
  if(!activityDates.includes(k)){
    activityDates.push(k);
    saveActivity();
  }
}

function loadStreakSaves(){
  try{
    const raw = window.localStorage.getItem(STREAK_SAVE_KEY);
    if(raw){ streakSaves = Object.assign({count:STREAK_SAVE_MAX, lastEarned:null, savedDates:[]}, JSON.parse(raw)); }
  }catch(e){}
  if(!streakSaves.lastEarned) streakSaves.lastEarned = todayKey();
}

function saveStreakSaves(){
  try{ window.localStorage.setItem(STREAK_SAVE_KEY, JSON.stringify(streakSaves)); }catch(e){}
  flagSync();
}

function daysSince(key){
  const [y,m,d] = key.split('-').map(Number);
  const then = new Date(y, m-1, d);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(),now.getMonth(),now.getDate()) - then) / 86400000);
}

// A kunai every STREAK_SAVE_DAYS days, capped at STREAK_SAVE_MAX. While you're
// holding a full set the clock idles, so the wait always starts from the moment
// you actually spent one.
function replenishStreakSaves(){
  // While the set is full the clock is not running, so there is nothing to
  // record. It used to stamp lastEarned with today here, which changed the
  // saved state on the first load of every new day for no reason anybody could
  // see, and that write was enough to mark the device as having local changes
  // to send. Under the sync rules of the time that meant a device holding
  // yesterday overwrote a newer copy on the server, having never read it. The
  // sync side no longer works that way, and this side no longer writes for the
  // sake of writing. Nothing reads lastEarned while the set is full: both
  // nextKunaiInDays and nextKunaiAt return before they reach it, and spending
  // one sets it in applyStreakSaves.
  if(streakSaves.count >= STREAK_SAVE_MAX) return;
  const elapsed = daysSince(streakSaves.lastEarned);
  if(elapsed >= STREAK_SAVE_DAYS){
    streakSaves.count = Math.min(STREAK_SAVE_MAX, streakSaves.count + Math.floor(elapsed/STREAK_SAVE_DAYS));
    streakSaves.lastEarned = todayKey();
  }
}

// Spends kunai on days you missed, so studyStreak() reads them as covered.
//
// Only ever to rescue the *current* streak, and only when the whole gap can be
// bridged. Two rules, both learned from getting it wrong:
//
// It used to walk back through the entire history hunting for any uncovered
// day, so a single old gap silently ate every kunai the user would ever earn.
// Lasz reported losing them while studying daily, and that was why: he had
// nineteen unbroken days and the kunai went on a gap twenty days back, which no
// amount of studying could ever repair.
//
// And it used to spend before checking the gap could be closed. A two-day
// absence covered yesterday, ran out, and left the streak broken anyway: the
// kunai gone and nothing bought with it.
function applyStreakSaves(){
  if(activityDates.length === 0 || streakSaves.count <= 0) return;

  const covered = new Set(activityDates.concat(streakSaves.savedDates));
  let d = addDays(new Date(), -1);

  // Yesterday is covered, so nothing is at risk. This is the ordinary case for
  // anyone studying regularly, and it must cost them nothing.
  if(covered.has(dateKey(d))) return;

  // Collect the run of missed days without touching state. One more than we
  // hold is enough to know the gap is too wide.
  const gap = [];
  while(gap.length <= streakSaves.count && !covered.has(dateKey(d))){
    gap.push(dateKey(d));
    d = addDays(d, -1);
  }
  if(gap.length > streakSaves.count) return;   // cannot bridge it, so don't try
  // Something has to be on the far side, or there is no streak to reconnect to
  // and a kunai would buy nothing. Tested against covered rather than activity
  // so an earlier save counts, the same way studyStreak() reads it.
  if(!covered.has(dateKey(d))) return;

  streakSaves.count -= gap.length;
  streakSaves.savedDates.push(...gap);
  // Set here rather than trusting replenishStreakSaves to have just run: the
  // wait for the next one starts when this one is actually spent.
  streakSaves.lastEarned = todayKey();
}

function refreshStreakSaves(){
  const before = JSON.stringify(streakSaves);
  replenishStreakSaves();
  applyStreakSaves();
  if(JSON.stringify(streakSaves) !== before) saveStreakSaves();
}

function nextKunaiInDays(){
  if(streakSaves.count >= STREAK_SAVE_MAX) return 0;
  return Math.max(0, STREAK_SAVE_DAYS - daysSince(streakSaves.lastEarned));
}

// Replenishment is reckoned in whole calendar days, so the kunai is back at
// the very start of the day STREAK_SAVE_DAYS after it was spent, midnight,
// not the time of day you happened to lose it.
function nextKunaiAt(){
  if(streakSaves.count >= STREAK_SAVE_MAX) return null;
  const [y,m,d] = streakSaves.lastEarned.split('-').map(Number);
  return new Date(y, m-1, d + STREAK_SAVE_DAYS);
}

function formatStamp(dt){
  const p = n => String(n).padStart(2,'0');
  return `${p(dt.getDate())}/${p(dt.getMonth()+1)}/${String(dt.getFullYear()).slice(-2)} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// Consecutive days with activity, counting back from today. A day that
// hasn't happened yet (no activity today) doesn't break yesterday's streak.
function studyStreak(){
  const set = new Set(activityDates.concat(streakSaves.savedDates));
  let d = new Date();
  if(!set.has(dateKey(d))){ d = addDays(d, -1); }
  let streak = 0;
  while(set.has(dateKey(d))){
    streak++;
    d = addDays(d, -1);
  }
  return streak;
}

function loadReviewHistory(){
  try{
    const raw = window.localStorage.getItem(REVIEW_HISTORY_KEY);
    if(raw){ reviewHistory = JSON.parse(raw); }
  }catch(e){}
}

function saveReviewHistory(){
  try{ window.localStorage.setItem(REVIEW_HISTORY_KEY, JSON.stringify(reviewHistory)); }catch(e){}
  flagSync();
}

function recordReviewCompleted(){
  const k = todayKey();
  reviewHistory[k] = (reviewHistory[k]||0) + 1;
  saveReviewHistory();
}

function reviewsCompletedOn(d){
  return reviewHistory[dateKey(d)] || 0;
}

function getEntry(id){ return progress[id] || {stage:0, nextReview:null}; }
function now(){ return Date.now(); }

// Only words with a written mnemonic are ready to be taught as lessons.
function learnableWords(){ return VOCAB.filter(v=>v.mnemonic); }

function dueReviews(){
  const t = now();
  return VOCAB.filter(v=>{
    const p = getEntry(v.id);
    return p.stage>=1 && p.stage<=8 && p.nextReview!==null && p.nextReview<=t;
  });
}
function newWords(){ return learnableWords().filter(v=>getEntry(v.id).stage===0); }
function nextUpcoming(){
  const t = now();
  const future = VOCAB.map(v=>getEntry(v.id)).filter(p=>p.stage>=1 && p.stage<=8 && p.nextReview!==null && p.nextReview>t);
  if(future.length===0) return null;
  return Math.min(...future.map(p=>p.nextReview));
}
function humanizeDuration(ms){
  if(ms<=0) return 'now';
  const mins = Math.round(ms/60000);
  if(mins<60) return mins+'m';
  const hrs = Math.round(mins/60);
  if(hrs<48) return hrs+'h';
  const days = Math.round(hrs/24);
  if(days<60) return days+'d';
  const months = Math.round(days/30);
  return months+'mo';
}

// Per-item history. Kept alongside stage and nextReview rather than in its own
// store so it travels with the item through sync and reset.
//
// Short keys on purpose: this whole object is one JSON blob in Postgres and
// eventually holds up to 1500 items, so "meaningCorrect" 1500 times is real
// weight for no benefit. m is meaning, r is reading, and within each c is
// correct, w is wrong, s is the current streak and b the best it has been.
//
// Only reviews are counted, not lesson quizzes and not extra study. Those are
// practice and do not move the SRS stage, so counting them would flatter the
// numbers and stop them meaning anything.
function blankStats(){ return { c:0, w:0, s:0, b:0 }; }

// When this item was last *decided*, so that two devices that both moved the
// same card since they last agreed can be told apart by the merge in sync.js
// rather than guessed at. Entries written before this existed have no stamp,
// and the merge has a rule for that; every one written from here on has one.
//
// Decided is the whole of it, and it is only called from the two places that
// decide: completing a lesson, and completing a review. It was briefly called
// from recordAnswer too, which stamps every individual half, and that broke the
// rule it exists to serve: a device answering one half at a later moment would
// out-stamp a device that had finished the word, and the merge would take the
// half-answered entry and put a completed card's stage back.
//
// The clock behind it is the device's own, so this orders two decisions only as
// well as two devices agree about the time. It is better evidence than the
// alternatives available here, not proof.
function touchEntry(id){
  const p = progress[id];
  if(p) p.t = now();
}

function ensureStats(id){
  const p = progress[id];
  if(!p) return null;
  if(!p.m) p.m = blankStats();
  if(!p.r) p.r = blankStats();
  return p;
}

function recordAnswer(id, type, correct){
  const p = ensureStats(id);
  if(!p) return;
  const s = (type === 'reading') ? p.r : p.m;
  if(correct){
    s.c++;
    s.s++;
    if(s.s > s.b) s.b = s.s;
  }else{
    s.w++;
    s.s = 0;
  }
  // Deliberately no touchEntry here: see the comment on it. One half being
  // answered is not the word being decided, and stamping it as though it were
  // lets a half-answer outrank a completed review in the merge.
  saveProgress();
}

function completeLesson(id){
  progress[id] = {
    stage: 1,
    nextReview: now() + INTERVAL_HOURS[1]*3600*1000,
    unlocked: now(),
    t: now(),
    m: blankStats(),
    r: blankStats()
  };
  saveProgress();
  incrementDailyLessons();
  recordActivityToday();
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function startLessonBatch(){
  const pending = newWords();
  const batchSize = plannedLessonBatchSize();
  if(batchSize===0) return;
  lessonState = { batch: pending.slice(0,batchSize).map(v=>v.id), phase:'study', studyIndex:0, showAnswer:false };
  render();
  autoPlayStudyWord();
}

// Called after the click that advanced the card, so browsers count it as
// user-initiated and don't block the audio.
function autoPlayStudyWord(){
  if(!settings.autoPlayLessonAudio) return;
  if(!lessonState || lessonState.phase!=='study') return;
  speakWord(lessonState.batch[lessonState.studyIndex]);
}

function nextStudyItem(){
  lessonState.studyIndex++;
  render();
  autoPlayStudyWord();
}

function prevStudyItem(){
  if(lessonState.studyIndex>0){
    lessonState.studyIndex--;
    render();
    autoPlayStudyWord();
  }
}

function startQuiz(){
  const quizProgress = {};
  const queue = [];
  lessonState.batch.forEach(id=>{
    quizProgress[id] = { meaning:false, reading:false };
    queue.push({id, type:'meaning'});
    queue.push({id, type:'reading'});
  });
  lessonState.phase = 'quiz';
  lessonState.quizQueue = shuffle(queue);
  lessonState.quizProgress = quizProgress;
  lessonState.showAnswer = false;
  render();
}

// The lesson quiz had the same fault as the review screen: everything was
// committed by the Next button, so answering the last question of an item and
// then leaving lost the unlock, having told you it was done. Grading commits
// here instead, and answerQuizQuestion is left with the queue to manage.
function commitQuizAnswer(){
  const q = lessonState.quizQueue[0];
  if(!lessonState.lastCorrect) return;
  lessonState.quizProgress[q.id][q.type] = true;
  if(lessonState.quizProgress[q.id].meaning && lessonState.quizProgress[q.id].reading){
    completeLesson(q.id);
  }
}

function answerQuizQuestion(correct){
  const q = lessonState.quizQueue.shift();
  // Anything not yet answered correctly comes back round a few questions later.
  if(!lessonState.quizProgress[q.id][q.type]){
    const insertAt = Math.min(lessonState.quizQueue.length, 3);
    lessonState.quizQueue.splice(insertAt, 0, q);
  }
  lessonState.showAnswer = false;
  lessonState.revealed = false;
  lessonState.mnemonicShown = false;
  render();
}

function submitQuizAnswer(){
  if(lessonState.showAnswer) return; // already graded; Next is the only way on
  const q = lessonState.quizQueue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('quizInput');
  const value = input ? input.value : '';
  if(!value.trim()) return; // don't let a stray Enter count as a wrong answer
  const correct = q.type==='meaning' ? checkMeaning(value, item.meaning, item) : checkReading(value, item.reading);
  lessonState.showAnswer = true;
  lessonState.lastCorrect = correct;
  lessonState.lastInput = value;
  lessonState.revealed = false;
  lessonState.mnemonicShown = false;
  commitQuizAnswer();
  render();
}

function saveLessonSettings(){
  const batchEl = document.getElementById('lessonBatchSizeInput');
  const dailyEl = document.getElementById('dailyLimitInput');
  let batch = parseInt(batchEl.value, 10);
  if(isNaN(batch) || batch < 1) batch = DEFAULT_SETTINGS.lessonBatchSize;
  let daily = parseInt(dailyEl.value, 10);
  if(isNaN(daily)) daily = DEFAULT_SETTINGS.dailyNewLimit;
  daily = Math.min(100, Math.max(0, daily));
  settings.lessonBatchSize = batch;
  settings.dailyNewLimit = daily;
  saveSettings();
  switchView('dashboard');
}

function saveThemeSetting(){
  const el = document.getElementById('themeInput');
  if(!el) return;
  settings.theme = el.value;
  saveSettings();
  applyTheme();
  // No re-render: the palette is entirely CSS variables, so the page it is
  // already showing changes underneath it and the select keeps its focus.
}

// The swatches do need a redraw, but only so the pressed one moves. Everything
// else on the page recolours itself through the variables, as above.
function choosePalette(id){
  if(!PALETTES.some(p => p.id === id)) return;
  settings.palette = id;
  saveSettings();
  applyTheme();
  focusAfterRender = `.palette-swatch[data-palette="${id}"]`;
  render();
}

function saveReviewSettings(){
  const indicatorEl = document.getElementById('srsIndicatorInput');
  const orderEl = document.getElementById('reviewOrderInput');
  const hideEl = document.getElementById('hideAnswerInput');
  const mnemEl = document.getElementById('showMnemonicInput');
  settings.showSrsIndicator = indicatorEl.value === 'yes';
  settings.reviewOrder = orderEl.value;
  settings.hideAnswerOnMistake = hideEl.value === 'manual';
  settings.showMnemonicOnAnswer = mnemEl.value === 'yes';
  saveSettings();
  switchView('dashboard');
}

function saveAudioSettings(){
  const autoEl = document.getElementById('autoPlayInput');
  const rateEl = document.getElementById('speechRateInput');
  const voiceEl = document.getElementById('voiceInput');
  const shippedEl = document.getElementById('shippedVoiceInput');
  // Both are already applied and saved on change; read them back anyway so Save
  // can't quietly revert a choice made in either dropdown.
  if(voiceEl && voiceEl.value) settings.voiceName = voiceEl.value;
  if(shippedEl && shippedEl.value && AUDIO_IDS[shippedEl.value]) settings.audioVoice = shippedEl.value;
  settings.autoPlayLessonAudio = autoEl.value === 'yes';
  let rate = parseFloat(rateEl.value);
  if(isNaN(rate)) rate = DEFAULT_SETTINGS.speechRate;
  settings.speechRate = Math.min(1.5, Math.max(0.5, rate));
  saveSettings();
  switchView('dashboard');
}

function computeReviewStage(stage, correct){
  if(correct) return Math.min(9, stage+1);
  return stage<=4 ? Math.max(1,stage-1) : Math.max(1,stage-2);
}

// Orders the whole question queue per the review-ordering setting. Meaning
// and reading questions stay interleaved across different words in every
// mode. Ordering only decides which items come earlier, never which half
// of an item you get asked first.
function orderReviewQueue(queue){
  if(settings.reviewOrder === 'genin-first'){
    const isGenin = q => TIER_COLOR(getEntry(q.id).stage) === 'genin';
    return shuffle(queue.filter(isGenin)).concat(shuffle(queue.filter(q=>!isGenin(q))));
  }
  if(settings.reviewOrder === 'lower-stage-first'){
    // Shuffle first, then sort by stage: Array#sort is stable, so items
    // sharing a stage keep their randomized order instead of deck order.
    return shuffle(queue).sort((a,b)=>getEntry(a.id).stage - getEntry(b.id).stage);
  }
  return shuffle(queue);
}

function buildReviewSession(){
  const due = dueReviews();
  if(due.length===0) return;
  const results = {};
  const queue = [];
  due.forEach(v=>{
    results[v.id] = { meaning:false, reading:false, missed:false };
    queue.push({id:v.id, type:'meaning'});
    queue.push({id:v.id, type:'reading'});
  });
  reviewState = { queue: orderReviewQueue(queue), results, showAnswer:false, lastCorrect:null, lastInput:'' };
  sessionCorrect = 0;
  sessionTotal = 0;
}

// An item's SRS stage only moves once both its meaning and reading have been
// answered correctly, and it only moves up if neither was missed along the
// way, same contract as WaniKani.
function applyReviewResult(id, allCorrect){
  const newStage = computeReviewStage(getEntry(id).stage, allCorrect);
  const nextReview = newStage===9 ? null : now() + INTERVAL_HOURS[newStage]*3600*1000;
  // Merge rather than replace. This line used to be an assignment, which threw
  // away everything except stage and nextReview on every single review, so any
  // history added elsewhere would have lasted until the item next came up.
  const p = progress[id] || {};
  p.stage = newStage;
  p.nextReview = nextReview;
  if(!p.unlocked) p.unlocked = now();  // items from before this existed
  progress[id] = p;
  ensureStats(id);
  touchEntry(id);
  saveProgress();
  recordActivityToday();
  recordReviewCompleted();
}

// After a wrong answer the correct one stays hidden until asked for, so the
// recall attempt isn't short-circuited. The sentence translation is withheld
// along with it, being the meaning in English. The mnemonic is not: it has a
// button of its own next to this one, because on a word you have just missed
// it is the thing you actually want, and it should not cost you the answer
// first. What it still governs is the mnemonic printing itself unasked.
function answerVisible(state){
  return state.lastCorrect || state.revealed || !settings.hideAnswerOnMistake;
}

// Every item is asked twice, meaning and reading, interleaved in one queue. So
// the panel shown after answering one half can hand over the other half before
// it's been asked: the sentence translation is the meaning in English, and the
// mnemonic gives away both. It tells the meaning story and signs off with the
// reading in kana. Nothing that does that is printed unasked while the sibling
// question is still pending. It no longer gates the "Show mnemonic" button,
// only the automatic reveals: missing either half loses the stage anyway, so
// there was nothing left for the gate to protect, and asking for a mnemonic is
// a deliberate press. `rest` is whatever is still to come, current excluded.
function siblingPending(rest, id){
  return rest.some(x => x.id === id);
}

// Is a reading question for this item still to come?
//
// The audio speaks the word's reading, so the speaker button on a graded answer
// is the reading, out loud, on demand. Offering it while the reading is still
// an unasked question hands over the answer: Lasz found it on a card where he
// had just got the meaning right, pressed play, and was read the half he had
// not been asked for yet.
//
// Deliberately narrower than siblingPending. Playing the word after the reading
// has been answered gives nothing away about a pending meaning question, and
// the audio is most of the point of the card, so it stays available there. And
// deliberately by type rather than by "which half am I on": a missed question
// goes back into the queue, so after a wrong reading answer the reading is
// pending again even though the reading is the half on screen.
function readingPending(rest, id){
  return rest.some(x => x.id === id && x.type === 'reading');
}

function revealReviewAnswer(){ reviewState.revealed = true; render(); }
function revealExtraStudyAnswer(){ extraStudyState.revealed = true; render(); }
function revealQuizAnswer(){ lessonState.revealed = true; render(); }

function revealMnemonic(which){
  const state = which === 'review' ? reviewState : which === 'lesson' ? lessonState : extraStudyState;
  if(state) state.mnemonicShown = true;
  render();
}

// The panel under a graded answer. Three screens show it and all three want the
// same bargain, so it lives here rather than being pasted three times.
//
// holdBack means the item's other half is still in the queue. It only applies
// to a correct answer, where that half is still a live question and the
// mnemonic would answer it early: the mnemonic tells the meaning story and ends
// on the reading.
//
// After a miss there is nothing left to protect. applyReviewResult runs on
// !res.missed, so one wrong half fails the whole item then and there, and no
// amount of reading the mnemonic afterwards can change the stage it lands on.
// Withholding it there only kept you from the explanation at the moment you had
// just proved you needed it. So on a miss it goes behind a button instead:
// asked for, not handed over, the same bargain the answer itself gets under
// "reveal only when asked".
//
// What that does cost: the other half can now be answered from the mnemonic
// rather than from memory, and that counts as a clean first attempt in the
// per-item stats and keeps it out of Recent Mistakes. The stage is already lost
// either way.
// Both halves are answered, the stage has moved and the item is finished for
// today. Nothing is left to hold back at that point: there is no unasked
// question for the mnemonic, the breakdown or the translation to give away. It
// is also the moment you are most likely to want to read the card, having just
// proved you know it, so the whole thing opens.
//
// The half just tested is already sitting in the result panel above, so only
// the other one is repeated here.
function completedCard(item, askedType){
  const other = askedType === 'meaning'
    ? `<div class="field"><div class="k">Reading</div><div class="v">${renderReading(item)}</div></div>`
    : `<div class="field"><div class="k">Meaning</div><div class="v">${escapeHtml(item.meaning)}</div></div>`;
  return `
    ${other}
    ${renderKanjiParts(item.word)}
    ${item.mnemonic ? `<div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>` : ''}
    ${item.notes ? `<div class="field" style="background:var(--kage-bg);"><div class="k" style="color:var(--kage);">Usage note</div><div class="v" style="font-size:13px;">${escapeHtml(item.notes)}</div></div>` : ''}
  `;
}

// On a wrong answer this is a second button under "Show answer" rather than
// something waiting behind it. The two reveals are independent: the mnemonic
// tells the meaning story and signs off with the reading, so for a word you
// have just missed it is often the more useful of the two, and making it the
// reward for giving up on the answer first put it a tap further away than it
// deserved.
function mnemonicPanel(state, item, holdBack, which){
  if(!item.mnemonic) return '';
  const field = `<div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>`;
  if(state.lastCorrect) return settings.showMnemonicOnAnswer && !holdBack ? field : '';
  if(state.mnemonicShown) return field;
  // Asking for it is always allowed; printing it unasked still waits for the
  // answer to be out. Otherwise "show mnemonic on answer" would quietly hand
  // over an answer that "hide answer on mistake" is holding back.
  if(settings.showMnemonicOnAnswer && answerVisible(state)) return field;
  return `<button class="secondary" onclick="revealMnemonic('${which}')">Show mnemonic</button>`;
}

// An answer counts the moment it is graded, not when Next is pressed.
//
// All of this used to sit in advanceReview, one tap later. Answering the last
// question of an item and then leaving by the nav instead of pressing Next
// threw the whole thing away: the panel had already announced Genin 1 to Genin
// 2 while the item was still sat at Genin 1, still in the due pile, and the
// day's review count still read zero. The screen promised something that only
// the next tap would deliver.
//
// It also means a session interrupted by a phone call or a closed tab keeps
// whatever was actually answered.
function commitReviewAnswer(){
  const q = reviewState.queue[0];
  const res = reviewState.results[q.id];
  sessionTotal++;
  if(reviewState.lastCorrect){
    sessionCorrect++;
    // Count the first attempt only. Getting it right on the retry after a miss
    // is still a miss for this review, which is how the percentage stays
    // meaningful rather than drifting to 100% for everybody.
    if(!res[q.type] && !res[q.type+'Missed']) recordAnswer(q.id, q.type, true);
    res[q.type] = true;
    if(res.meaning && res.reading){
      // Capture the stage either side, because the panel reports what happened
      // now rather than predicting what Next would do.
      const from = getEntry(q.id).stage;
      applyReviewResult(q.id, !res.missed);
      reviewState.stageChange = { from, to: getEntry(q.id).stage };
    }
  }else if(!res[q.type+'Missed']){
    res[q.type+'Missed'] = true;
    res.missed = true;
    recordAnswer(q.id, q.type, false);
    recordMistake(q.id, q.type);
  }
}

function submitReviewAnswer(){
  if(reviewState.showAnswer) return; // already graded; Next is the only way on
  const q = reviewState.queue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('reviewInput');
  const value = input ? input.value : '';
  if(!value.trim()) return; // don't let a stray Enter demote the item
  reviewState.lastCorrect = q.type==='meaning'
    ? checkMeaning(value, item.meaning, item)
    : checkReading(value, item.reading);
  reviewState.lastInput = value;
  reviewState.showAnswer = true;
  reviewState.revealed = false;
  reviewState.mnemonicShown = false;
  reviewState.stageChange = null;
  commitReviewAnswer();
  render();
}

function advanceReview(){
  const q = reviewState.queue.shift();
  const res = reviewState.results[q.id];
  // Anything still not answered correctly goes back in a few questions later.
  // The grading itself already happened at submit time.
  if(!res[q.type]){
    const insertAt = Math.min(reviewState.queue.length, 3);
    reviewState.queue.splice(insertAt, 0, q);
  }
  reviewState.showAnswer = false;
  reviewState.lastCorrect = null;
  reviewState.lastInput = '';
  reviewState.revealed = false;
  reviewState.mnemonicShown = false;
  reviewState.stageChange = null;
  render();
}

function startExtraStudy(){
  const ids = recentMistakeIds();
  if(ids.length===0) return;
  // Drill each missed word as a whole, both halves, interleaved, since a
  // mistake is recorded against the word, not against one half of it.
  const queue = [];
  ids.forEach(id=>{
    queue.push({id, type:'meaning'});
    queue.push({id, type:'reading'});
  });
  extraStudyState = { queue: shuffle(queue), index:0, showAnswer:false, wordCount: ids.length };
  view = 'extrastudy';
  render();
}

function submitExtraStudyAnswer(){
  const q = extraStudyState.queue[extraStudyState.index];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('extraInput');
  const value = input ? input.value : '';
  if(!value.trim()) return;
  extraStudyState.lastCorrect = q.type==='meaning'
    ? checkMeaning(value, item.meaning, item)
    : checkReading(value, item.reading);
  extraStudyState.lastInput = value;
  extraStudyState.showAnswer = true;
  extraStudyState.revealed = false;
  extraStudyState.mnemonicShown = false;
  render();
}

function advanceExtraStudy(){
  extraStudyState.index++;
  extraStudyState.showAnswer = false;
  extraStudyState.revealed = false;
  extraStudyState.mnemonicShown = false;
  render();
}

// The welcome page is the one view worth having a URL, so it can be sent to
// somebody. Only ever touches the hash when it is empty or exactly #welcome:
// Supabase returns from a magic link with the tokens in the hash, and wiping
// those would break sign-in.
function syncWelcomeHash(v){
  try{
    const h = window.location.hash;
    if(v === 'welcome' && h !== '#welcome'){
      if(h === '') history.replaceState(null, '', '#welcome');
    }else if(v !== 'welcome' && h === '#welcome'){
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }catch(e){}
}

function switchView(v){
  syncWelcomeHash(v);
  view = v;
  extraStudyState = null;
  // Arranging is a thing you are doing to the dashboard, so leaving it ends.
  // Coming back to a dashboard still in arrange mode, with no memory of having
  // asked for it, would read as the app being broken.
  if(v !== 'dashboard') arrangingDashboard = false;
  // Reviews run as a session; leaving and coming back resumes the same one,
  // and a fresh session (with a fresh tally) is only built once it's done.
  if(v==='review' && !reviewState) buildReviewSession();
  render();
}

function resetProgress(){
  if(!confirm('Reset all progress? This clears every SRS level, your recent mistakes, review history and study streak. It cannot be undone.')) return;
  progress = {};
  mistakes = [];
  activityDates = [];
  streakSaves = { count: STREAK_SAVE_MAX, lastEarned: todayKey(), savedDates: [] };
  reviewHistory = {};
  dailyLessons = { date: todayKey(), count: 0 };
  sessionCorrect=0; sessionTotal=0;
  lessonState = null;
  reviewState = null;
  extraStudyState = null;
  saveProgress();
  saveMistakes();
  saveActivity();
  saveStreakSaves();
  saveReviewHistory();
  saveDailyLessons();
  // An erasure is the one change sync must not merge away. Without this the
  // next reconcile would see items this device no longer has, decide it had
  // simply never learned them, and hand every one of them back.
  if(typeof syncForceLocal === 'function') syncForceLocal();
  switchView('dashboard');
}

function nav(active){
  const due = dueReviews().length;
  const lessons = Math.min(newWords().length, remainingToday());
  return `<nav>
    <button onclick="navTo('dashboard')" class="${active==='dashboard'?'active':''}">Dashboard</button>
    <button onclick="navTo('lessons')" class="${active==='lessons'?'active':''}">Lessons (${lessons})</button>
    <button onclick="navTo('review')" class="${active==='review'?'active':''}">Reviews (${due})</button>
  </nav>`;
}

// ---- Leaving a review before it is finished --------------------------------
//
// Worth being exact about what is at stake, because the honest answer is less
// alarming than it sounds and the message should say the true thing.
//
// Leaving is not destructive on its own. The session lives in memory and coming
// back to Reviews resumes it at the same question. Every word already finished
// was written the moment its second half was answered, so none of that is at
// risk either.
//
// What is at risk is a word part-way through. A word progresses only when its
// meaning and its reading are both right, so until then no stage has been
// written for it and the session holding that half-finished state is memory
// only. Close the tab and the word comes round again whole.
//
// Not that nothing at all has been written for it: recordAnswer and
// recordMistake save the statistics and the mistake as they happen, so Extra
// Study and the accuracy counts survive. It is the SRS decision that does not.
//
// Part-way includes a word that has only been got wrong. That state is
// {meaning:false, reading:false, missed:true}, which a test for "exactly one
// half is right" reads as untouched, and the confirm then said nothing was
// waiting while a demotion the reader had earned was about to be dropped.
//
// The confirm is here as much for the mis-tap as for the risk. Back sits beside
// the button you press hundreds of times in a session.
function partlyReviewedCount(){
  if(!reviewState) return 0;
  return Object.values(reviewState.results).filter(r =>
    (r.meaning || r.reading || r.missed) && !(r.meaning && r.reading)
  ).length;
}

function confirmLeavingReview(){
  if(!reviewState || reviewState.queue.length === 0) return true;
  const part = partlyReviewedCount();
  const risk = part > 0
    ? `${part} word${part===1 ? ' is' : 's are'} part-way through. A word progresses only when its meaning and its reading are both right, so ${part===1 ? 'that one starts' : 'those start'} again if you close Emaki before coming back.`
    : 'Nothing is part-way through at the moment.';
  return confirm(`Leave this review session?\n\nEvery word you have finished is already saved. ${risk}\n\nComing back to Reviews picks up where you left off.`);
}

function leaveReviewSession(){
  if(!confirmLeavingReview()) return;
  switchView('dashboard');
}

// The nav sits on the review screen too, so its buttons are the other way out
// and need the same guard. On every other screen this is switchView unchanged.
function navTo(v){
  if(view === 'review' && v !== 'review' && !confirmLeavingReview()) return;
  switchView(v);
}

// ---- The dashboard ---------------------------------------------------------
//
// It used to be one template string in a fixed order. It is now a list of named
// sections rendered in whatever order the reader has put them in, because the
// right order is not the same for everybody: somebody drilling reviews wants the
// counts at the top, somebody working through lessons wants the streak where
// they can see it, and somebody who never uses the word search wants it gone.
//
// A section is one card, or one pair of cards that only make sense side by side.
// The pairs move as a unit rather than as two halves, so every arrangement is
// still a composed layout rather than a half-width card stranded next to a gap.
//
// The order and the hidden list live in settings, so they sync with everything
// else and a phone and a desktop agree about the dashboard.
const DASHBOARD_SECTIONS = [
  { id:'cta',      label:'Reviews and lessons',      render:renderCtaSection },
  { id:'search',   label:'Look up a word',           render:renderSearchCard },
  { id:'mistakes', label:'Recent mistakes',          render:renderMistakesSection },
  { id:'stats',    label:'Reviews today and streak', render:renderStatsSection },
  { id:'week',     label:'This week',                render:renderWeekSection },
  { id:'tiers',    label:'Stage counts',             render:renderTiersSection }
];

// Arranging is a mode, not a setting. The setting is the layout it produces.
// Kept out of `settings` on purpose: leaving your phone in arrange mode should
// not put your desktop in arrange mode when it next syncs.
let arrangingDashboard = false;

// Everything the sections need, worked out once. Several of these walk the whole
// deck, and six sections each calling dueReviews() for themselves would be six
// passes over 1500 words to draw one screen.
function dashboardContext(){
  const counts = {new:0,genin:0,chunin:0,jonin:0,anbu:0,kage:0};
  VOCAB.forEach(v=>{ counts[TIER_COLOR(getEntry(v.id).stage)]++; });
  refreshStreakSaves();
  return {
    counts,
    due: dueReviews().length,
    upcoming: nextUpcoming(),
    lessonsAvailable: Math.min(newWords().length, remainingToday()),
    mistakeItems: recentMistakeIds().map(id=>VOCAB.find(v=>v.id===id)).filter(Boolean),
    todayCount: reviewsCompletedOn(),
    yesterdayCount: reviewsCompletedOn(addDays(new Date(), -1)),
    streak: studyStreak()
  };
}

// The stored order, made safe to use. Two things it has to survive: an id that
// no longer exists, from a section that was removed or renamed, and a section
// that the stored order has never heard of. The second is the one that matters —
// a card added in a later version must appear for somebody who arranged their
// dashboard last year, rather than silently never showing up.
function dashboardLayout(){
  const known = new Map(DASHBOARD_SECTIONS.map(s=>[s.id, s]));
  const stored = Array.isArray(settings.dashboardOrder) ? settings.dashboardOrder : [];
  const out = [], seen = new Set();
  for(const id of stored){
    if(known.has(id) && !seen.has(id)){ out.push(known.get(id)); seen.add(id); }
  }
  // Appended rather than dropped in at its position in the shipped order. For
  // a dashboard nobody has arranged the two are the same thing, because the
  // stored order is empty and they arrive in order anyway. For one somebody has
  // arranged, inserting by shipped index lands a new card in the middle of a
  // sequence they chose on purpose, and the bottom is both less rude and easier
  // to find on the way to moving it.
  DASHBOARD_SECTIONS.forEach(s=>{ if(!seen.has(s.id)) out.push(s); });
  return out;
}

function dashboardHiddenIds(){
  return Array.isArray(settings.dashboardHidden) ? settings.dashboardHidden.slice() : [];
}

function renderDashboard(){
  const c = dashboardContext();
  const hidden = new Set(dashboardHiddenIds());
  const sections = dashboardLayout();

  const body = arrangingDashboard
    ? sections.map(s=>renderArrangeWrapper(s, c, hidden.has(s.id))).join('')
    : sections.filter(s=>!hidden.has(s.id)).map(s=>s.render(c)).join('');

  // Everything visible turned off is a legitimate choice, but a blank screen
  // looks broken rather than chosen, and there would be no way back to the
  // arranging screen from it.
  const allOff = !arrangingDashboard && sections.every(s=>hidden.has(s.id));

  return `
  ${nav('dashboard')}
  ${renderSyncPrompt()}
  ${arrangingDashboard ? renderArrangeBar() : ''}
  <div id="dashSections">${body}</div>
  ${allOff ? `<div class="card" style="margin-bottom:16px;">
    <div class="empty" style="padding:14px 0;">Every card is hidden. Use ⠿ at the top to bring one back.</div>
  </div>` : ''}
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="resetProgress()">Reset all progress</button>
  </div>
  `;
}

function renderCtaSection(c){
  return `
  <div class="grid2">
    <div class="card cta-card">
      <div class="cta-label">Reviews</div>
      <div class="cta-count">${c.due}</div>
      <div class="cta-sub">${c.due>0 ? 'Reviews are ready.' : (c.upcoming ? `Next batch in ${humanizeDuration(c.upcoming-now())}` : 'All caught up.')}</div>
      <button class="primary" onclick="switchView('review')">Start Reviews</button>
    </div>
    <div class="card cta-card">
      <div class="cta-label">Today's Lessons</div>
      <div class="cta-count">${c.lessonsAvailable}</div>
      <div class="cta-sub">${c.lessonsAvailable>0 ? 'Learn something new.' : 'None available right now.'}</div>
      <button class="primary" onclick="switchView('lessons')">Start Lessons</button>
    </div>
  </div>`;
}

function renderMistakesSection(c){
  const mistakeItems = c.mistakeItems;
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Recent Mistakes</div>
    <div class="forecast" style="margin-top:-4px;margin-bottom:12px;">From the past 24 hours.</div>
    ${mistakeItems.length===0 ? `<div class="empty" style="padding:16px 0;">No recent mistakes. Nice work.</div>` : `
      <div class="tilegrid">
        ${mistakeItems.slice(0, MISTAKE_TILE_LIMIT).map(item=>{
          const tier = TIER_COLOR(getEntry(item.id).stage);
          return `<span class="tile" style="background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});border-color:var(--${tier});" title="${escapeHtml(item.reading + ', ' + item.meaning)}">${escapeHtml(item.word)}</span>`;
        }).join('')}
        ${mistakeItems.length > MISTAKE_TILE_LIMIT ? `<span class="tile tile-more">+${mistakeItems.length - MISTAKE_TILE_LIMIT}</span>` : ''}
      </div>
      <button class="primary" style="margin-top:14px;" onclick="startExtraStudy()">Extra Study (${mistakeItems.length})</button>
    `}
  </div>`;
}

function renderStatsSection(c){
  return `
  <div class="grid2">
    <div class="card stat-card">
      <div class="section-title">Reviews Today</div>
      <div class="cta-count">${c.todayCount}</div>
      <div class="cta-sub">Yesterday: ${c.yesterdayCount}</div>
    </div>
    <div class="card stat-card">
      <div class="section-title">Study Streak</div>
      <div class="cta-count">${c.streak}</div>
      <div class="cta-sub">${c.streak>0 ? `day${c.streak===1?'':'s'} in a row` : 'study today to start one'}</div>
      <div class="kunai ${streakSaves.count>0?'held':'spent'}">
        <svg class="kunai-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="3.1" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11.2" y="5.2" width="1.6" height="3.6" fill="currentColor"/><path d="M12 8.6 L15.4 12.4 L12 23 L8.6 12.4 Z" fill="currentColor"/></svg>
        <span>${streakSaves.count>0 ? 'Kunai ready' : 'Kunai spent'}</span>
      </div>
      <div class="kunai-note">${streakSaves.count>0
        ? `Miss a day and this covers it. A new one ${STREAK_SAVE_DAYS} days after it's used.`
        : `It covered a missed day.<br>New kunai ${formatStamp(nextKunaiAt())}.`}</div>
    </div>
  </div>`;
}

function renderWeekSection(){
  return `
  <div class="card" style="margin-bottom:20px;">
    <div class="section-title">This Week</div>
    ${renderStreakWeek()}
  </div>`;
}

// Each rank's paper, sampled from its own artwork: the average of the blank
// panel to the left of the characters, with anything gold or inked excluded.
// The tier list continues this colour below the painting, so Anbu's grey and
// Kage's cream carry on as themselves rather than as one shared beige.
const TIER_PAPER = {
  new:'#beb7ac', genin:'#e1ceb6', chunin:'#e7d5ba',
  jonin:'#f5e2c7', anbu:'#bcb2aa', kage:'#eedfcd'
};

// The tier colours from the light theme, which are the ones drawn to hold up on
// a pale ground. The dark-theme set is tuned for a dark card and goes to mud on
// paper.
const TIER_INK = {
  new:'#878d9c', genin:'#b34a1e', chunin:'#5646c0',
  jonin:'#1a6ba3', anbu:'#137a55', kage:'#8a6512'
};

// Two ways of drawing the same six counts.
//
// The painted scrolls belong to the paper palettes. On Classic they would be
// six pieces of aged parchment in the middle of a flat blue-grey app, which is
// not a look anybody chose, and Classic's promise is that it is unchanged. So
// Classic keeps the plain buttons it has always had and the paper palettes get
// the artwork. It is the same data, the same target and the same behaviour
// either way: press one and the tier list opens.
function renderTiersSection(c){
  const tiers = ['new','genin','chunin','jonin','anbu','kage'];
  if(currentPalette().skin !== 'paper'){
    return `
    <div class="grid3">
      ${tiers.map(t=>`
        <button class="stat stat-btn" onclick="showTier('${t}')" title="Show these words">
          <div class="n">${c.counts[t]}</div><div class="l">${t.charAt(0).toUpperCase()+t.slice(1)}</div>
        </button>`).join('')}
    </div>`;
  }
  return `
  <div class="rank-row">
    ${tiers.map(t=>`
      <button class="rank-card" onclick="showTier('${t}')" title="Show these words">
        <img src="img/ranks/${t}.webp" alt="" loading="lazy" width="440" height="147">
        <span class="rank-count">${c.counts[t]}</span>
        <span class="rank-name">${t.charAt(0).toUpperCase()+t.slice(1)}</span>
      </button>`).join('')}
  </div>`;
}

// ---- Arranging -------------------------------------------------------------
//
// Dragging is the obvious gesture and it is what Lasz asked for, but it cannot
// be the only one. A drag needs a pointer, a steady hand and sight of the
// screen, so the handle is also a button that moves its section with the arrow
// keys. That covers a keyboard, a screen reader, and the case where a drag on a
// phone turns into a scroll.
//
// The handle is the only draggable part rather than the whole card. Grabbing
// anywhere would mean `touch-action:none` over the entire dashboard, and then a
// finger swipe to scroll would pick a card up instead.

// One line rather than a card. The button that turned arranging on is still
// sitting in the header waiting to turn it off, so a panel repeating that in a
// box of its own would be furniture.
function renderArrangeBar(){
  return `
  <div class="arr-top">
    <span>Drag a card by its handle, or select one and use the arrow keys.</span>
    <button class="reset-link" onclick="resetDashboardLayout()">Restore the default order</button>
  </div>`;
}

function renderArrangeWrapper(section, c, isHidden){
  return `
  <div class="arr${isHidden ? ' arr-off' : ''}" data-sec="${section.id}">
    <div class="arr-bar">
      <button class="arr-grip" type="button"
              onpointerdown="startSectionDrag(event,'${section.id}')"
              onkeydown="sectionGripKey(event,'${section.id}')"
              aria-label="Move ${escapeHtml(section.label)}"
              title="Drag to move, or use the arrow keys">⠿</button>
      <span class="arr-name">${escapeHtml(section.label)}${isHidden ? ' — hidden' : ''}</span>
      <button class="secondary arr-toggle" type="button"
              onclick="toggleDashboardSection('${section.id}')"
              aria-pressed="${isHidden ? 'false' : 'true'}">${isHidden ? 'Show' : 'Hide'}</button>
    </div>
    ${isHidden ? '' : `<div class="arr-body">${section.render(c)}</div>`}
  </div>`;
}

// The header button is both the way in and the way out, so it toggles. It only
// exists on the dashboard, because it is the only screen there is anything to
// arrange on.
function toggleArrangingDashboard(){
  arrangingDashboard ? stopArrangingDashboard() : startArrangingDashboard();
}

function startArrangingDashboard(){
  arrangingDashboard = true;
  view = 'dashboard';
  syncWelcomeHash(view);
  render();
}

function stopArrangingDashboard(){
  arrangingDashboard = false;
  render();
}

function toggleDashboardSection(id){
  const hidden = new Set(dashboardHiddenIds());
  if(hidden.has(id)) hidden.delete(id); else hidden.add(id);
  // A fresh array every time. DEFAULT_SETTINGS is copied by reference into
  // settings for any key the saved copy doesn't have, so pushing into one of
  // its arrays would edit the defaults for the rest of the session.
  settings.dashboardHidden = Array.from(hidden);
  saveSettings();
  focusAfterRender = `.arr[data-sec="${id}"] .arr-toggle`;
  render();
}

function setDashboardOrder(ids){
  settings.dashboardOrder = ids.slice();
  saveSettings();
}

function moveDashboardSection(id, delta){
  const ids = dashboardLayout().map(s=>s.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if(from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  setDashboardOrder(ids);
  focusAfterRender = `.arr[data-sec="${id}"] .arr-grip`;
  render();
}

function resetDashboardLayout(){
  settings.dashboardOrder = null;
  settings.dashboardHidden = null;
  saveSettings();
  render();
}

function sectionGripKey(e, id){
  if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
    e.preventDefault();
    moveDashboardSection(id, e.key === 'ArrowUp' ? -1 : 1);
  }
}

// ---- Dragging one section --------------------------------------------------
//
// The card being dragged is taken out of the flow and pinned to the pointer,
// and a placeholder of the same height holds its slot. Everything else then
// reflows on its own as the placeholder moves, which is what makes the gap open
// where the card is going to land without moving any other element by hand.
//
// Only the vertical position follows the pointer. The dashboard is one column,
// so horizontal freedom would buy nothing and would let somebody drag a card
// off the side of a phone.
let dashDrag = null;

function startSectionDrag(e, id){
  if(!arrangingDashboard) return;
  if(e.button !== undefined && e.button !== 0) return;   // right-click, not a drag
  // A second finger, or a drag whose end was never seen. Without this the new
  // drag overwrites dashDrag and the old card is left pinned to the page with
  // nothing holding its slot.
  cancelSectionDrag();
  const list = document.getElementById('dashSections');
  const wrap = list && list.querySelector(`.arr[data-sec="${id}"]`);
  if(!wrap) return;
  e.preventDefault();

  const rect = wrap.getBoundingClientRect();
  const holder = document.createElement('div');
  holder.className = 'arr-placeholder';
  holder.style.height = rect.height + 'px';
  wrap.after(holder);

  wrap.classList.add('arr-dragging');
  wrap.style.width = rect.width + 'px';
  wrap.style.left = rect.left + 'px';
  wrap.style.top = rect.top + 'px';

  dashDrag = { id, wrap, holder, list, grabY: e.clientY - rect.top, y: e.clientY, scroll: 0 };

  // Keeps the moves coming to the handle even when the pointer outruns it.
  // Throws if the pointer has already gone by the time we ask, which is not a
  // reason to abandon the drag: the document listeners below are what actually
  // drive it.
  try{ e.target.setPointerCapture(e.pointerId); }catch(err){}
  document.addEventListener('pointermove', onSectionDragMove);
  document.addEventListener('pointerup', endSectionDrag);
  document.addEventListener('pointercancel', endSectionDrag);
  // Alt-tabbing away mid-drag never produces a pointerup, and the card would
  // stay pinned to the screen with the edge-scroll timer still running.
  window.addEventListener('blur', cancelSectionDrag);
}

function detachDrag(){
  document.removeEventListener('pointermove', onSectionDragMove);
  document.removeEventListener('pointerup', endSectionDrag);
  document.removeEventListener('pointercancel', endSectionDrag);
  window.removeEventListener('blur', cancelSectionDrag);
  stopEdgeScroll();
}

// Puts everything back without committing an order. Called before any dashboard
// redraw, because a render replaces the whole list and would otherwise detach
// the card and its placeholder while the listeners, the timer and dashDrag
// itself carried on referring to elements no longer on the page. A background
// sync is enough to cause that render.
function cancelSectionDrag(){
  if(!dashDrag) return;
  const { wrap, holder } = dashDrag;
  dashDrag = null;
  detachDrag();
  if(wrap){
    wrap.classList.remove('arr-dragging');
    wrap.style.width = wrap.style.left = wrap.style.top = '';
  }
  if(holder && holder.parentNode) holder.remove();
}

function onSectionDragMove(e){
  if(!dashDrag) return;
  dashDrag.y = e.clientY;
  dashDrag.wrap.style.top = (e.clientY - dashDrag.grabY) + 'px';
  placeSectionHolder(e.clientY);
  edgeScroll(e.clientY);
}

// The slot the card would land in: the first section whose middle the pointer is
// above. Measured live rather than from a table taken at the start, because the
// list reflows as the placeholder moves and a cached table would be wrong the
// moment anything shifted.
function placeSectionHolder(y){
  const { list, holder, wrap } = dashDrag;
  let before = null;
  for(const el of Array.from(list.children)){
    if(el === wrap || el === holder) continue;
    const r = el.getBoundingClientRect();
    if(y < r.top + r.height/2){ before = el; break; }
  }
  if(before) list.insertBefore(holder, before);
  else list.appendChild(holder);
}

// Dragging to a slot that is off the screen has to be possible, and on a phone
// most of them are.
let edgeScrollTimer = null;
function edgeScroll(y){
  const edge = 80;
  let step = 0;
  if(y < edge) step = -Math.ceil((edge - y) / 6);
  else if(y > window.innerHeight - edge) step = Math.ceil((y - (window.innerHeight - edge)) / 6);
  dashDrag.scroll = step;
  if(step === 0){ stopEdgeScroll(); return; }
  if(edgeScrollTimer) return;
  edgeScrollTimer = setInterval(()=>{
    if(!dashDrag || !dashDrag.scroll){ stopEdgeScroll(); return; }
    window.scrollBy(0, dashDrag.scroll);
    placeSectionHolder(dashDrag.y);
  }, 16);
}

function stopEdgeScroll(){
  if(edgeScrollTimer){ clearInterval(edgeScrollTimer); edgeScrollTimer = null; }
}

function endSectionDrag(){
  if(!dashDrag) return;
  const { wrap, holder, list, id } = dashDrag;
  detachDrag();

  wrap.classList.remove('arr-dragging');
  wrap.style.width = wrap.style.left = wrap.style.top = '';
  list.insertBefore(wrap, holder);
  holder.remove();
  dashDrag = null;

  const order = Array.from(list.children).map(el=>el.dataset.sec).filter(Boolean);
  setDashboardOrder(order);
  focusAfterRender = `.arr[data-sec="${id}"] .arr-grip`;
  render();
}

// ---- The week, as forehead protectors ---------------------------------------
// Monday to Sunday, one headband a day. A day you studied wears an intact leaf.
// A day a kunai covered wears a slashed one, the way a shinobi who has left
// their village scores a line through the symbol: the streak survived, but not
// cleanly, and the mark says so at a glance.
//
// Drawn rather than imported. Every piece is a plain shape so it inherits the
// theme's colours and stays sharp at any size, and so the repository carries no
// artwork it has no right to.
const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Monday of the week `today` falls in. getDay() calls Sunday 0, which would put
// Sunday at the start of its own week rather than the end of the previous one.
function weekStart(d){
  const day = (d.getDay() + 6) % 7;   // Monday 0 ... Sunday 6
  return addDays(d, -day);
}

function headbandSvg(state){
  // One drawing, four readings. The plate and the cloth are always there; what
  // changes is what the plate carries and how much of it is lit.
  //
  // The plate is a wide rectangle, near enough 2.1 to 1, because that is what a
  // forehead protector is. It was briefly square, which let the emblem be much
  // larger but stopped it reading as a headband at all.
  //
  // The leaf is the emblem itself, not a drawing of it. Earlier attempts here
  // redrew it by hand from a description and never looked right, because the
  // coil holds a near-constant radius for most of a turn and then dives, which
  // no tidy spiral does. This path is the reference bitmap run through a
  // marching-squares trace and simplified, so it is correct by construction
  // rather than by eye. The tracer lives in the private repo; run it again if
  // the source image ever changes.
  //
  // One filled path with evenodd, not four strokes: the emblem is a single
  // spiral whose boundary winds in and out, and evenodd turns that into the
  // holes for free. Drawn in its own 100-unit space and scaled onto the plate.
  const slash = state === 'saved'
    ? `<path class="hb-slash" d="M5.4 9.81 L13 9.26 L32 9.26 L38.6 9.81 L32 10.36 L13 10.36 Z"/>`
    : '';
  return `<svg class="hb hb-${state}" viewBox="0 0 44 19" aria-hidden="true">
    <rect class="hb-cloth" x="0"    y="4.5" width="6.5" height="10" rx="1.2"/>
    <rect class="hb-cloth" x="37.5" y="4.5" width="6.5" height="10" rx="1.2"/>
    <rect class="hb-plate" x="5"    y="1.5" width="34"  height="16" rx="2.6"/>
    <g class="hb-leaf" transform="translate(14.66 3.51) scale(0.1465)">
      <path fill-rule="evenodd" d="M96.6 0L98 -0.1L99.2 0.3L99.9 1L100.1 2.4L99.3 4.3L94.9 8.8L93.7 9.7L87.4 15.8L83.3 18.8L81.3 18.6L73.2 14.9L63.2 12.5L61.4 12.5L60.4 12.1L52.8 11.9L49.2 12.1L48.2 12.5L44.7 12.9L40.7 14.1L37 15.8L33.3 18L30.1 20.6L27.5 23.4L25.1 26.8L22.7 31.5L21.2 35.6L20.4 39.2L20 43.3L20.2 47.6L20.8 51.4L22.9 57.3L24.3 60.2L27.5 64.8L30.3 67.6L32.5 69.2L36.8 71.6L41.7 73.7L47 74.9L55.1 74.9L57.7 74.5L64 72.5L68.7 69.6L73.3 65L76.1 60.2L77.3 56.7L77.9 53.9L78.2 46.7L76.7 40.9L75.7 38.4L74.1 35.8L70.9 32.2L68.3 30.2L64 28.2L57.9 26.9L54.3 26.9L53 27.3L51.6 27.3L48 28.6L43.5 31.4L40.5 34.6L38.9 38L38.1 41.1L37.9 46.3L38.5 49.4L40.1 52.4L42.3 54.8L43.9 56L47.8 57.6L51.8 58L55.3 57.2L57.3 56L59.9 53L60.7 51L61.1 47.2L60.3 44.9L57.8 42.1L57 40L57 39L57.9 37.5L58.7 37.1L60.8 37.1L62.6 37.9L64.3 39.6L66 42.3L66.8 44.7L66.8 46.3L67.2 47.4L67.2 50.2L66.4 54.5L65.1 57.1L62.2 60.5L59.3 62.5L55.3 64.1L52.8 64.5L49.4 64.5L47 64.1L42.5 62.5L38.2 59.7L34.9 56.1L32.4 51.8L31.2 47.6L31.2 41.3L32.4 36.8L34.9 32.3L35.3 32.1L37.3 28.7L38.2 27.7L42.5 24.5L45.7 22.9L49.8 21.6L56.3 20.8L61.8 21.2L65.4 22.1L68.9 23.3L74.4 26.5L79 31.1L82.4 36.8L84.5 42.9L85.1 48L85.1 51.6L84.5 56.9L82.4 63.6L80 68.3L78.2 70.9L74 74.7L68.1 78.6L65 79.8L60.6 81L55.7 81.4L54.3 81.8L33.7 81.8L32.1 81.4L16.1 81.8L14 81.4L11.4 81.4L10.2 81L2.8 81L1.4 80.6L0.1 79.5L0.1 75.6L1.7 71.5L1.7 70.7L2.5 69.1L7.4 53.9L7.8 53.5L7.8 52.6L8.2 52.2L8.2 51.4L9 49.8L9.9 46.5L10.3 46.1L11.1 43.1L11.5 42.7L11.5 41.9L12.3 40.2L13.9 34.8L15.5 30.7L18 25.6L21 20.7L24.5 16.7L26.4 14.9L32.1 11.1L37 8.8L42.1 7.2L50.4 6L57.9 6L67.5 7.2L75.4 9.2L78 10.5L81.7 11.7L82.5 11.7L94.5 1.1L95.5 0.3ZM14.3 53.7L14.7 53.7L15.1 56.7L16.8 61.2L19.6 66.1L22.1 69.1L25 72.1L29.1 75.3L15.9 75.3L9.1 74.9L7.7 75.1L7.2 74.8L8.2 71.7L8.2 70.9L8.6 70.5L10.7 64.4L10.7 63.6L11.9 60.4L11.9 59.6L12.3 59.1L12.3 58.3L12.7 57.9L13.1 56.1Z
"/>
    </g>
    ${slash}
    <g class="hb-rivets">
      <circle cx="8.2"  cy="4.6" r="0.7"/><circle cx="8.2"  cy="9.5" r="0.7"/><circle cx="8.2"  cy="14.4" r="0.7"/>
      <circle cx="35.8" cy="4.6" r="0.7"/><circle cx="35.8" cy="9.5" r="0.7"/><circle cx="35.8" cy="14.4" r="0.7"/>
    </g>
  </svg>`;
}

function renderStreakWeek(){
  // One reading of the clock. Sampling it twice let midnight fall between them,
  // so the strip could take yesterday as "today" and build today's week around
  // it. Sunday into Monday was the worst of it: a fresh Monday-to-Sunday row
  // with no today in it at all.
  const now     = new Date();
  const today   = dateKey(now);
  const start   = weekStart(now);
  const studied = new Set(activityDates);
  const saved   = new Set(streakSaves.savedDates || []);
  // A day before the user's first ever activity was not missed, it was simply
  // before they started. Telling somebody who opened the app on Wednesday that
  // they missed Monday and Tuesday is both wrong and discouraging.
  const began   = activityDates.length ? activityDates.slice().sort()[0] : today;

  const cells = WEEKDAYS.map((label, i) => {
    const key = dateKey(addDays(start, i));
    // Order matters: a day can be in both sets if the clock moved or two tabs
    // raced, and having actually studied is the truer thing to show.
    const state = studied.has(key) ? 'studied'
                : saved.has(key)   ? 'saved'
                : key === today    ? 'pending'
                : key > today      ? 'future'
                : key < began      ? 'untracked'
                : 'missed';
    const said = { studied: 'studied', saved: 'covered by a kunai',
                   pending: 'not studied yet', future: 'still to come',
                   untracked: 'no study recorded', missed: 'missed' }[state];
    // The visible label is hidden from the reading, because the sentence below
    // already begins with it and otherwise it is announced twice.
    return `<li class="hb-day hb-day-${state}${key === today ? ' hb-today' : ''}">
      ${headbandSvg(state)}
      <span class="hb-label" aria-hidden="true">${label}</span>
      <span class="visually-hidden">${label}, ${said}</span>
    </li>`;
  }).join('');

  return `<ul class="hb-week" aria-label="This week">${cells}</ul>`;
}

// Somewhere for a reader to say a card is wrong. Kaishi has a few hundred
// closed issues, most of them exactly this, so these will arrive. Pre-filling
// the word and id matters more than it looks: a report that just says "the
// あつい one is wrong" costs an exchange of messages to place, and most people
// will not bother with the second message.
const ISSUE_URL = 'https://github.com/Jilien91/emaki/issues/new';

function reportCardUrl(item){
  const title = `Card ${item.id}: ${item.word} (${item.reading})`;
  const body = [
    `**Card:** ${item.id} ${item.word} (${item.reading}) - ${item.meaning}`,
    '',
    '**What looks wrong:**',
    '',
    '',
    '_(mnemonic, usage note, kanji breakdown, reading, example sentence, anything)_'
  ].join('\n');
  return ISSUE_URL + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
}

function reportCardLink(item){
  return `<div style="text-align:center;margin-top:10px;">
    <a class="reset-link" style="text-decoration:none;" href="${escapeHtml(reportCardUrl(item))}" target="_blank" rel="noopener noreferrer">Something wrong with this card?</a>
  </div>`;
}

// Shown instead of the dashboard to anybody who has not started yet. Somebody
// arriving from a link needs to know what this is and, more importantly,
// whether it is for them: the deck is written entirely in kana and kanji with
// no romaji anywhere, so without kana it is unusable rather than merely hard.
// Saying that up front is kinder than letting them find out on card one.
const WELCOME_KEY = 'kaishi-welcome-seen';
function welcomeSeen(){
  try{ return window.localStorage.getItem(WELCOME_KEY) === '1'; }catch(e){ return false; }
}
function dismissWelcome(){
  try{ window.localStorage.setItem(WELCOME_KEY, '1'); }catch(e){}
  switchView('dashboard');
}
function isNewHere(){
  return Object.keys(progress).length === 0 && !welcomeSeen();
}

function renderWelcome(){
  const ready = learnableWords().length;
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">What Emaki is</div>
    <p class="footer-note" style="text-align:left;">
      A spaced-repetition trainer built around the
      <a href="https://github.com/donkuri/Kaishi" target="_blank" rel="noopener noreferrer">Kaishi 1.5k</a>
      Japanese vocabulary deck, with a written mnemonic for every word and a
      breakdown of the kanji it is built from. ${ready} of ${VOCAB.length} words have
      mnemonics so far and only those appear in lessons. It is free, there are no
      adverts, and your progress is saved in this browser.
    </p>
    <p class="footer-note" style="text-align:left;color:var(--text);">
      <b>Emaki is not affiliated with, or endorsed by, Kaishi 1.5k or its authors.</b>
      The word list is theirs and is used with their kind permission. The mnemonics,
      the kanji breakdowns and this app are not their work, so any complaint about
      them belongs here rather than there.
    </p>
  </div>

  <div class="card" style="margin-bottom:16px;background:var(--kage-bg);">
    <div class="section-title" style="color:var(--kage);">Is this for you yet?</div>
    <p class="footer-note" style="text-align:left;">
      Emaki assumes that you can read/write hiragana and katakana. If this is the
      case, go ahead and hit that button below.
    </p>
    <p class="footer-note" style="text-align:left;">
      If you cannot, you should learn these first. It only takes a few hours or a
      couple of days at max. Tofugu's guides are amazing and I highly recommend them:
      <a href="https://www.tofugu.com/japanese/learn-hiragana/" target="_blank" rel="noopener noreferrer">hiragana</a>
      and
      <a href="https://www.tofugu.com/japanese/learn-katakana/" target="_blank" rel="noopener noreferrer">katakana</a>.
      You can practice them on
      <a href="https://djtguide.github.io/learn/kana.html" target="_blank" rel="noopener noreferrer">this</a>
      website. Come back after you are confident and all of this will make a great
      deal more sense.
    </p>
    <p class="footer-note" style="text-align:left;">
      The reason for this is simple. Every card on Emaki is kana and kanji with no
      romaji anywhere, and you type your answers in kana as well, so it would be a
      frustrating place to begin without it.
    </p>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">How it works</div>
    <p class="footer-note" style="text-align:left;">
      You learn a few words at a time in a lesson, then the app asks for them again
      at widening intervals: 4h, 8h, a day, two days, a week, and on up to four
      months. Get one wrong and it comes back sooner. The ranks on the dashboard,
      Genin through Kage, are how far along that ladder each word has climbed.
    </p>
    <p class="footer-note" style="text-align:left;">
      Sign in from Settings and your progress follows you to other devices. You do
      not have to, and everything works signed out.
    </p>
  </div>

  <div class="btnrow">
    <button class="primary" onclick="dismissWelcome()">Start studying</button>
  </div>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="switchView('info')">More detail</button>
  </div>
  `;
}

// Look a word up without starting a review. Matches the written form and the
// reading, and the meaning too, because a search box that cannot find "shop"
// when you type shop feels broken even if it was only ever advertised for
// Japanese.
//
// Romaji is converted with wanakana, so hanashi finds はなし without needing an
// IME. The raw text is searched as well, since converting an English word
// produces kana nonsense that must not be the only thing tried.
const SEARCH_LIMIT = 60;
let searchQuery = '';

function searchMatches(raw){
  const q = (raw || '').trim().toLowerCase();
  if(q.length < 1) return [];
  const kana = window.wanakana ? window.wanakana.toHiragana(q) : q;
  const kata = window.wanakana ? window.wanakana.toKatakana(q) : q;

  const scored = [];
  for(const v of VOCAB){
    const word = v.word.toLowerCase();
    const reading = v.reading.toLowerCase();
    const meaning = v.meaning.toLowerCase();
    let score = 0;
    // Exact hits first, then starts-with, then anywhere. Written form and
    // reading outrank meaning so typing kana never buries what you meant.
    if(word === q || word === kana || word === kata || reading === kana || reading === q) score = 100;
    else if(word.startsWith(q) || word.startsWith(kana) || reading.startsWith(kana) || reading.startsWith(q)) score = 80;
    else if(word.includes(q) || word.includes(kana) || reading.includes(kana) || reading.includes(q)) score = 60;
    else if(meaning === q) score = 50;
    else if(meaning.startsWith(q)) score = 40;
    else if(meaning.includes(q)) score = 20;
    if(score) scored.push([score, v]);
  }
  scored.sort((a,b)=> b[0]-a[0] || a[1].id-b[1].id);
  return scored.map(s=>s[1]);
}

function renderSearchResults(){
  const hits = searchMatches(searchQuery);
  if(!searchQuery.trim()) return '';
  if(hits.length === 0){
    return `<div class="empty" style="padding:12px 0;">Nothing matches that.</div>`;
  }
  // Unlike the rank tiles, these carry the reading and meaning. A hit that
  // matched on はな or on "flower" looks identical to its homophone as a bare
  // kanji, so the tile has to show what it matched on.
  const tiles = hits.slice(0, SEARCH_LIMIT).map(v=>{
    const p = getEntry(v.id);
    const tier = TIER_COLOR(p.stage);
    return `<button class="hit tile-btn" style="background:var(--${tier}-bg,var(--surface-2));border-color:var(--${tier});"
      onclick="showItem(${v.id},'dashboard')">
      <span class="hit-w jp" style="color:var(--${tier});">${escapeHtml(v.word)}</span>
      <span class="hit-r jp">${escapeHtml(v.reading)}</span>
      <span class="hit-m">${escapeHtml(v.meaning)}</span>
    </button>`;
  }).join('');
  return `<div class="hitgrid">${tiles}</div>
    <div class="forecast" style="margin-top:10px;">
      ${hits.length} match${hits.length===1?'':'es'}${hits.length > SEARCH_LIMIT ? `, showing the first ${SEARCH_LIMIT}` : ''}. Coloured by rank.
    </div>`;
}

// Updates only the results, never the whole view. A full render would replace
// the input element mid-keystroke and take the caret with it.
function onSearchInput(el){
  searchQuery = el.value;
  const box = document.getElementById('searchResults');
  if(box) box.innerHTML = renderSearchResults();
}
function clearSearch(){
  searchQuery = '';
  render();
}

function renderSearchCard(){
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Look up a word</div>
    <div class="settings-row">
      <input type="text" id="searchInput" placeholder="kanji, kana, romaji or English"
             value="${escapeHtml(searchQuery)}" oninput="onSearchInput(this)"
             autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
    </div>
    <div id="searchResults">${renderSearchResults()}</div>
    ${searchQuery ? `<div style="text-align:center;margin-top:10px;"><button class="reset-link" onclick="clearSearch()">Clear</button></div>` : ''}
  </div>`;
}

// Drill-down from the rank tiles on the dashboard.
let tierView = 'genin';
function showTier(t){ tierView = t; switchView('tierlist'); }

function renderTierList(){
  const tier = tierView;
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  // "New" means never studied, so it is the only tier where the sensible list
  // is what you could learn next rather than everything unstudied. Words with
  // no mnemonic cannot be learned yet and would just be noise.
  const items = tier === 'new'
    ? learnableWords().filter(v=>getEntry(v.id).stage === 0)
    : VOCAB.filter(v=>{ const p = getEntry(v.id); return p.stage > 0 && TIER_COLOR(p.stage) === tier; });

  // Soonest first for anything scheduled; New has no schedule so keep deck order.
  if(tier !== 'new'){
    items.sort((a,b)=>{
      const pa = getEntry(a.id), pb = getEntry(b.id);
      if(pa.stage !== pb.stage) return pa.stage - pb.stage;
      return (pa.nextReview || Infinity) - (pb.nextReview || Infinity);
    });
  }

  const CAP = 300;
  const t = now();

  // On the scroll the tiles are ink on paper, so they carry only the tier's
  // colour for their edge and let the stylesheet do the rest. The dark-card
  // colours are set inline, and an inline style beats any rule, so the two
  // cases have to be written separately rather than overridden.
  const onPaper = currentPalette().skin === 'paper';
  const tiles = items.slice(0, CAP).map(v=>{
    const p = getEntry(v.id);
    const due = p.nextReview == null
      ? (p.stage === 9 ? 'burned' : 'not started')
      : (p.nextReview <= t ? 'due now' : 'in ' + humanizeDuration(p.nextReview - t));
    const hint = `${v.reading}, ${v.meaning}\n${STAGE_NAMES[p.stage]}, ${due}`;
    const style = onPaper
      ? `--ink-tier:${TIER_INK[tier]};`
      : `background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});border-color:var(--${tier});`;
    return `<button class="tile tile-btn jp" style="${style}"
      onclick="showItem(${v.id})" title="${escapeHtml(hint)}">${escapeHtml(v.word)}</button>`;
  }).join('');

  const caption = `${items.length} word${items.length===1?'':'s'}${items.length > CAP ? `, showing the first ${CAP}` : ''}.
      ${tier === 'new'
        ? 'Ready to learn but not started. Tap one to read its card.'
        : 'Soonest due first. Tap one to read its card.'}`;
  const body = items.length === 0
    ? `<div class="empty" style="padding:16px 0;">Nothing at this rank yet.</div>`
    : `<div class="tilegrid">${tiles}</div>`;

  // The scroll unrolled. The painting is the top of the sheet and its paper
  // carries on down behind the words, so the list is written on the scroll
  // rather than sitting on a card underneath a picture of one.
  //
  // The paper colour is sampled from each rank's own artwork, so Anbu's grey
  // and Kage's cream continue as themselves. The panel is inset by the width of
  // the rollers, which is about 4% on all six, or the paper would be wider
  // below the painting than in it.
  if(currentPalette().skin === 'paper'){
    return `
    ${nav('dashboard')}
    <div class="rank-sheet" style="--sheet-paper:${TIER_PAPER[tier]};">
      <div class="rank-top">
        <img src="img/ranks/${tier}.webp" alt="" width="440" height="147">
        <span class="rank-count">${items.length}</span>
        <span class="rank-name">${label}</span>
      </div>
      <div class="rank-paper">
        <div class="forecast">${caption}</div>
        ${body}
      </div>
    </div>
    <div style="text-align:center;margin-top:10px;">
      <button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button>
    </div>
    `;
  }

  return `
  ${nav('dashboard')}
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">${label}</div>
    <div class="forecast" style="margin-top:-4px;margin-bottom:12px;">
      ${caption}
    </div>
    ${body}
  </div>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button>
  </div>
  `;
}

// A card you can read without being quizzed on it and without it counting for
// anything. Same content as the lesson screen, deliberately: the point is to
// look up a word you half remember, so it should look like where you met it.
let detailId = null;
let itemOrigin = 'tierlist';
function showItem(id, origin){
  detailId = id;
  itemOrigin = origin || 'tierlist';
  switchView('item');
}

// Nine segments for the nine stages above New, filled up to where the item is.
// Stage 0 lights none of them, which is the right picture for a word that has
// not been started.
function stageBar(stage, tier){
  const cells = Array.from({length:9}, (_,i)=>`<span class="${i < stage ? 'on' : ''}"></span>`).join('');
  return `<div class="stagebar" style="--tier-color:var(--${tier});">${cells}</div>`;
}

// The per-item history panel. Everything in it comes from recordAnswer, which
// counts first attempts in reviews and nothing else, so these are recall
// numbers: lesson quizzes and extra study leave them alone, and getting a word
// right on the retry after a miss still reads here as a miss.
function renderItemStats(p){
  const m = p.m || blankStats();
  const r = p.r || blankStats();
  const attempts = m.c + m.w + r.c + r.w;
  const age = p.unlocked ? now() - p.unlocked : null;
  // Old items predate `unlocked` and only get one backfilled at their next
  // review, so the line has to be droppable rather than assumed.
  const since = age == null ? ''
    : age < 60000 ? 'Unlocked just now'
    : 'Unlocked ' + humanizeDuration(age) + ' ago';

  const note = txt => `<div class="field"><div class="k">History</div><div class="v" style="font-size:13px;color:var(--text-dim);">${txt}</div></div>`;

  // The card is reached from the rank tiles and from search, so a word nobody
  // has touched arrives here too. Both of these say as much instead of
  // printing 0% and reading like a failure.
  if(p.stage === 0) return note('Not started. Nothing is counted until this word has been learned and comes back for its first review.');
  if(attempts === 0) return note(since ? since + '. No reviews yet.' : 'No reviews yet.');

  const rows = [['meaning','Meaning',m], ['reading','Reading',r]].map(([cls,label,s])=>{
    const seen = s.c + s.w;
    // One half can be answered and the other still be waiting in the queue, so
    // a type with no attempts is a real state and not just a new item.
    const score = seen === 0 ? 'Not asked yet' : `${s.c} of ${seen} · ${Math.round(s.c/seen*100)}%`;
    const streak = seen === 0 ? '' : `<span class="statrow-streak">Streak ${s.s} · best ${s.b}</span>`;
    return `<div class="statrow">
      <span class="pill q-${cls}">${label}</span>
      <span class="statrow-body"><span class="statrow-score">${score}</span>${streak}</span>
    </div>`;
  }).join('');

  return `<div class="field">
    <div class="k">History</div>
    <div class="statrows">${rows}</div>
    ${since ? `<div class="statfoot">${since}</div>` : ''}
  </div>`;
}

function renderItemDetail(){
  const item = VOCAB.find(v=>v.id === detailId);
  if(!item) return renderTierList();
  const p = getEntry(item.id);
  const tier = TIER_COLOR(p.stage);
  const t = now();
  const due = p.stage === 0 ? 'Not started'
    : p.nextReview == null ? (p.stage === 9 ? 'Burned, no more reviews' : 'Not scheduled')
    : p.nextReview <= t ? 'Due now'
    : 'Next review in ' + humanizeDuration(p.nextReview - t);

  return `
  ${nav('dashboard')}
  <div class="bigword" style="background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});">
    <span class="word-line">${escapeHtml(item.word)}${audioBtn('speakWord', item.id, 'Play word')}</span>
    <div style="font-size:20px;color:var(--text-dim);margin-top:10px;">${renderReading(item)}</div>
  </div>
  <div class="field"><div class="k">Meaning</div><div class="v">${escapeHtml(item.meaning)}</div></div>
  ${renderKanjiParts(item.word)}
  ${item.mnemonic
    ? `<div class="field"><div class="k">Mnemonic</div><div class="v mnem">${escapeHtml(item.mnemonic)}</div></div>`
    : `<div class="field"><div class="k">Mnemonic</div><div class="v" style="color:var(--text-faint);">Not written yet. This word cannot be learned until it is.</div></div>`}
  ${item.notes ? `<div class="field" style="background:var(--kage-bg);"><div class="k" style="color:var(--kage);">Usage note</div><div class="v" style="font-size:13px;">${escapeHtml(item.notes)}</div></div>` : ''}
  <div class="field"><div class="k">Example</div><div class="v jp" style="margin-bottom:4px;">${escapeHtml(item.sentence)}</div><div class="v" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.sentence_meaning)}</div></div>
  <div class="field">
    <div class="k">Progress</div>
    <div class="v" style="display:flex;align-items:center;gap:10px;">
      <span class="pill" style="background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});">${STAGE_NAMES[p.stage]}</span>
      <span style="font-size:13px;color:var(--text-dim);">${due}</span>
    </div>
    ${stageBar(p.stage, tier)}
  </div>
  ${renderItemStats(p)}
  ${reportCardLink(item)}
  <div style="text-align:center;margin-top:14px;">
    ${itemOrigin === 'dashboard'
      ? `<button class="secondary" onclick="switchView('dashboard')">Back to search</button>`
      : `<button class="secondary" onclick="switchView('tierlist')">Back to ${tierView.charAt(0).toUpperCase()+tierView.slice(1)}</button>`}
  </div>
  `;
}

function renderInfo(){
  const learnableCount = learnableWords().length;
  return `
  <p class="footer-note" style="text-align:left;">
    <a href="https://github.com/donkuri/Kaishi" target="_blank" rel="noopener noreferrer">Kaishi 1.5k</a>
    deck: ${learnableCount} of ${VOCAB.length} words have mnemonics and are ready to learn.
    <b>Emaki is not affiliated with, or endorsed by, Kaishi 1.5k or its authors</b>, who kindly
    gave permission for the word list to be used here.<br><br>
    SRS intervals follow WaniKani's timing: 4h → 8h → 1d → 2d → 1wk → 2wk → 1mo → 4mo → Kage.<br><br>
    <b>Kunai.</b> You hold one at a time. Miss a single day and it is spent automatically to keep
    your study streak alive, and you will see it marked as spent on the dashboard. A replacement
    arrives ${STREAK_SAVE_DAYS} days later. Miss two days together and it stays in your hand: one
    kunai cannot bridge a two-day gap, so spending it would cost you the kunai and break the
    streak anyway.<br><br>
    ${storageOk ? '<span class="savebadge"><span class="dot"></span>Progress saves automatically</span>' : '<span class="savebadge"><span class="dot off"></span>Storage unavailable. Progress will not persist this session</span>'}
  </p>
  <p class="footer-note" style="text-align:left;">
    <b>Found a mistake?</b> The mnemonics and the kanji breakdowns are written by
    hand and some of them will be wrong. There is a link at the bottom of every
    lesson card, or
    <a href="${ISSUE_URL}" target="_blank" rel="noopener noreferrer">open an issue</a>
    directly. Corrections are welcome and get folded into the next batch.
  </p>
  <div style="text-align:center;margin-top:16px;">
    <button class="reset-link" onclick="switchView('welcome')">Show the welcome page</button>
  </div>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button>
  </div>
  `;
}

function renderLessons(){
  if(lessonState){
    return lessonState.phase==='study' ? renderLessonStudy() : renderLessonQuiz();
  }
  const pending = newWords();
  if(pending.length===0){
    return `${nav('lessons')}<div class="empty">No new lessons available.<br>All words with mnemonics have been started.</div>`;
  }
  const remaining = remainingToday();
  if(remaining===0){
    return `${nav('lessons')}<div class="empty">You've reached today's limit of ${settings.dailyNewLimit} new lesson${settings.dailyNewLimit===1?'':'s'}.<br>Come back tomorrow, or raise your limit in <span style="text-decoration:underline;cursor:pointer;" onclick="switchView('settings')">Settings</span>.</div>`;
  }
  const batchSize = plannedLessonBatchSize();
  return `
  ${nav('lessons')}
  <div class="card" style="text-align:center;">
    <div style="font-size:15px;margin-bottom:6px;">Ready to start ${batchSize} new lesson${batchSize===1?'':'s'}?</div>
    <div class="forecast" style="margin-bottom:14px;">You'll study each word, then get quizzed on its meaning and reading before it's added to reviews.</div>
    <button class="primary" onclick="startLessonBatch()">Begin lessons</button>
  </div>
  `;
}

// ---- Pitch accent -------------------------------------------------------
// Tokyo pitch accent, drawn over the reading. From data/pitch.json, built by
// scripts/extract-pitch.pl out of UniDic, where the accent type is the mora
// number carrying the nucleus and 0 means heiban, no drop at all.
//
// This exists because the audio cannot carry it. Heiban and odaka sound
// identical in a word spoken alone, and every one of the 3,000 shipped mp3s is
// a word spoken alone: the difference only appears on whatever follows. So the
// distinction is drawn rather than pronounced, which is also the more useful
// way round for a deck that explains things.
//
// 1390 of 1500 cards have a pattern. The rest are mostly set phrases with no
// single accent to give, and they show nothing. A blank means not supplied and
// must never be read as heiban.
let PITCH = {};

// Morae, not characters. A small kana rides on the one before it; っ, ん and ー
// each count on their own. Checked against all 1500 readings in the deck: no
// small vowels, no ー, one katakana reading, テレビ.
const SMALL_KANA = 'ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ';
function splitMorae(reading){
  const out = [];
  for(const ch of reading){
    if(out.length && SMALL_KANA.includes(ch)) out[out.length-1] += ch;
    else out.push(ch);
  }
  return out;
}

// Which morae are high, for accent type `a` over `n` morae.
//   0        low, then high all the way, and stays high onto the next word
//   1        high on the first mora only, then low
//   2..n     low, high up to the nucleus, low after it
// The tail is what a following particle would do, and it is the only thing
// separating heiban from an accent on the final mora.
function pitchShape(a, n){
  const high = [];
  for(let i = 1; i <= n; i++){
    if(a === 0)      high.push(i !== 1);
    else if(a === 1) high.push(i === 1);
    else             high.push(i !== 1 && i <= a);
  }
  return { high, tailHigh: a === 0, drops: a > 0 };
}

function pitchFor(id, reading){
  const entry = PITCH[id];
  if(!entry) return null;
  const match = entry.find(e => e.reading === reading);
  if(!match || !match.atypes || !match.atypes.length) return null;
  // Coerced rather than trusted. These are numbers in the file, but a string
  // "0" here would make every heiban word draw flat and low, which reads as a
  // deliberate pattern rather than as a bug.
  return match.atypes.map(Number).filter(n => Number.isInteger(n));
}

// A pure formatter, deliberately. It draws a reading it is given and decides
// nothing about whether the reading should be on screen: that stays with
// answerVisible and the sibling-question rules, which is where it can be
// reasoned about.
function renderReading(item, reading){
  // Called with no reading, draw all of them. Three cards carry two, 何 なに・なん,
  // 四 よん・し and 七 なな・しち, and taking [0] here silently dropped the second
  // everywhere a reading appears. Each alternative has its own accent, so each
  // gets its own drawing.
  if(reading === undefined){
    const parts = item.reading.split('・').map(s => s.trim()).filter(Boolean);
    return parts.map(p => renderReading(item, p))
                .join('<span class="pitch-sep">・</span>');
  }

  const r = reading;
  const atypes = pitchFor(item.id, r);
  if(!atypes) return `<span class="jp">${escapeHtml(r)}</span>`;

  const morae = splitMorae(r);
  const shape = pitchShape(atypes[0], morae.length);
  const cells = morae.map((m, i) => {
    const isHigh = shape.high[i];
    const next   = i + 1 < morae.length ? shape.high[i+1] : shape.tailHigh;
    // The turn is always a boundary *after* this mora, whether it goes up or
    // down, so both strokes belong on its right edge.
    const turn   = isHigh !== next ? (isHigh ? ' fall' : ' rise') : '';
    return `<span class="mora ${isHigh ? 'high' : 'low'}${turn}">${escapeHtml(m)}</span>`;
  }).join('');
  // The tail carries the heiban/odaka distinction, so it is never omitted.
  const tail = `<span class="pitch-tail ${shape.tailHigh ? 'high' : 'low'}"></span>`;
  // UniDic can offer several accepted patterns in priority order, not frequency
  // order. Only the first is drawn, because two overlapping lines are
  // unreadable, so the label has to say which one that was: 144 of the 1393
  // readings here have an alternative, which is too many to leave ambiguous.
  const first = atypes[0];
  const rest  = atypes.slice(1);
  const label = rest.length ? `${first} (also ${rest.join(', ')})` : String(first);
  const name  = first === 0 ? 'heiban, no drop'
              : first === morae.length ? `drops after the word, on mora ${first}`
              : `drops after mora ${first}`;
  const spoken = `${r}, primary pitch accent ${first}, ${name}`
               + (rest.length ? `. Also accepted: ${rest.join(', ')}` : '');
  // role="img" because ARIA forbids naming a generic span, so without it a
  // screen reader would drop the label and read the bare morae with a stray
  // number after them.
  return `<span class="pitch jp" role="img" title="${escapeHtml(spoken)}"
    aria-label="${escapeHtml(spoken)}">${cells}${tail}<span class="accent-type" aria-hidden="true">${escapeHtml(label)}</span></span>`;
}

// Shows what each kanji in the word is built from. Recognition aid only,
// these aren't SRS items, they're context while the word is being taught.
function renderKanjiParts(word){
  const chars = Array.from(word).filter(ch => KANJI[ch]);
  if(chars.length === 0) return '';
  const rows = chars.map(ch=>{
    const k = KANJI[ch];
    const detail = k.parts && k.parts.length
      ? k.parts.map(p=>`<span class="part"><span class="jp">${escapeHtml(p.c)}</span> ${escapeHtml(p.name)}</span>`).join('<span class="plus">+</span>')
      : `<span class="part-note">${escapeHtml(k.note || '')}</span>`;
    return `<div class="kanjirow">
      <span class="jp kanjirow-char">${escapeHtml(ch)}</span>
      <span class="kanjirow-body"><span class="kanjirow-meaning">${escapeHtml(k.meaning)}</span><span class="kanjirow-parts">${detail}</span></span>
    </div>`;
  }).join('');
  return `<div class="field"><div class="k">Built from</div><div class="kanjiparts">${rows}</div></div>`;
}

function renderLessonStudy(){
  const {batch, studyIndex} = lessonState;
  const item = VOCAB.find(v=>v.id===batch[studyIndex]);
  const isLast = studyIndex === batch.length-1;
  return `
  ${nav('lessons')}
  <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;text-align:center;">Lesson ${studyIndex+1} of ${batch.length}</div>
  <div class="bigword" style="background:var(--genin-bg);color:var(--genin);">
    <span class="word-line">${escapeHtml(item.word)}${audioBtn('speakWord', item.id, 'Play word')}</span>
    <div style="font-size:20px;color:var(--text-dim);margin-top:10px;">${renderReading(item)}</div>
  </div>
  <div class="field"><div class="k">Meaning</div><div class="v">${escapeHtml(item.meaning)}</div></div>
  ${renderKanjiParts(item.word)}
  <div class="field"><div class="k">Mnemonic</div><div class="v mnem">${escapeHtml(item.mnemonic)}</div></div>
  ${item.notes ? `<div class="field" style="background:var(--kage-bg);"><div class="k" style="color:var(--kage);">Usage note</div><div class="v" style="font-size:13px;">${escapeHtml(item.notes)}</div></div>` : ''}
  <div class="field"><div class="k">Example</div><div class="v jp" style="margin-bottom:4px;">${escapeHtml(item.sentence)}</div><div class="v" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.sentence_meaning)}</div></div>
  <div class="btnrow">
    ${studyIndex>0 ? `<button class="secondary" onclick="prevStudyItem()">Back</button>` : ''}
    <button class="primary" onclick="${isLast?'startQuiz()':'nextStudyItem()'}">${isLast?'Start quiz':'Next'}</button>
  </div>
  ${reportCardLink(item)}
  `;
}

function renderLessonQuiz(){
  const {quizQueue} = lessonState;
  if(quizQueue.length===0){
    const batchLen = lessonState.batch.length;
    lessonState = null;
    // Offer the next batch here rather than making you walk back out to the
    // Lessons tab to start it again.
    const next = plannedLessonBatchSize();
    let follow;
    if(next > 0){
      follow = `<button class="primary" onclick="startLessonBatch()">Study the next ${next}</button>
        <div style="text-align:center;margin-top:10px;"><button class="reset-link" onclick="switchView('dashboard')">That's enough for now</button></div>`;
    }else if(remainingToday() === 0){
      follow = `<p class="forecast" style="text-align:center;">That's your ${settings.dailyNewLimit} new words for today. Come back tomorrow, or raise the limit in <span style="text-decoration:underline;cursor:pointer;" onclick="switchView('settings')">Settings</span>.</p>`;
    }else{
      follow = `<p class="forecast" style="text-align:center;">No more words are ready to learn yet.</p>`;
    }
    return `${nav('lessons')}<div class="empty">Lesson batch complete: ${batchLen} word${batchLen===1?'':'s'} added to reviews.<br>First review in 4 hours.</div>${follow}`;
  }
  const q = quizQueue[0];
  const holdBack = siblingPending(quizQueue.slice(1), q.id);
  const readingHeld = readingPending(quizQueue.slice(1), q.id);
  const item = VOCAB.find(v=>v.id===q.id);
  const label = q.type==='meaning' ? 'Meaning' : 'Reading';
  const qClass = q.type==='meaning' ? 'q-meaning' : 'q-reading';
  return `
  ${nav('lessons')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <span style="font-size:12px;color:var(--text-dim);">Quiz · ${quizQueue.length} left</span>
    <span class="pill ${qClass}">${label}</span>
  </div>
  <div class="bigword ${qClass}">${escapeHtml(item.word)}</div>
  <div class="field"><div class="k">Example</div><div class="v jp">${escapeHtml(item.sentence)}</div></div>
  ${!lessonState.showAnswer ? `
    <input type="text" id="quizInput" placeholder="Type the ${label.toLowerCase()}" ${ANSWER_INPUT_ATTRS}>
    <button class="primary" onclick="submitQuizAnswer()">Check</button>
  ` : `
    <div class="field result-${lessonState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${lessonState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(lessonState) && !readingHeld ? audioBtn('speakWord', item.id, 'Play word') : ''}</div>
      ${answerVisible(lessonState) ? `<div class="v">${q.type==="meaning" ? escapeHtml(item.meaning) : renderReading(item)}</div>` : ""}
      ${!lessonState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(lessonState)?'margin-top:6px;':''}">You typed: ${escapeHtml(lessonState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${answerVisible(lessonState) ? '' : `
      <button class="secondary" onclick="revealQuizAnswer()">Show answer</button>
    `}
    ${mnemonicPanel(lessonState, item, holdBack, 'lesson')}
    <button class="primary" onclick="answerQuizQuestion(${lessonState.lastCorrect})">Next</button>
  `}
  `;
}

function renderSettings(){
  const batchOptions = [3,5,10,15,20];
  if(!batchOptions.includes(settings.lessonBatchSize)) batchOptions.push(settings.lessonBatchSize);
  batchOptions.sort((a,b)=>a-b);
  const dailyLabel = settings.dailyNewLimit===0
    ? `${dailyLessons.count} new lesson${dailyLessons.count===1?'':'s'} today (no daily limit)`
    : `${dailyLessons.count} of ${settings.dailyNewLimit} new lessons today`;
  const theme = settings.theme || 'system';
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Appearance</div>
    <div class="settings-row">
      <div class="settings-label">Theme</div>
      <div class="settings-desc">Follow the system and Emaki changes when your device does. Choosing light or dark here fixes it either way, whatever the device is set to.</div>
      <select id="themeInput" onchange="saveThemeSetting()">
        <option value="system" ${theme==='system'?'selected':''}>Follow system</option>
        <option value="light" ${theme==='light'?'selected':''}>Light</option>
        <option value="dark" ${theme==='dark'?'selected':''}>Dark</option>
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Palette</div>
      <div class="settings-desc">Which colours, separately from light and dark. Every palette has both, so this and the setting above do not fight each other. Classic is the one Emaki has always used; the other four are paper, and change the numerals to the serif as well as the colour.</div>
      <div class="palette-row">
        ${PALETTES.map(p=>`
        <button class="palette-swatch" type="button" data-palette="${p.id}"
                onclick="choosePalette('${p.id}')"
                aria-pressed="${settings.palette===p.id ? 'true' : 'false'}"
                title="${escapeHtml(p.label)}">
          <span class="pv" style="background:${p.bg[resolvedTheme()]};--sw-accent:${p.accent};"></span>
          <span class="pl">${escapeHtml(p.label)}</span>
        </button>`).join('')}
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Lesson Settings</div>
    <div class="settings-row">
      <div class="settings-label">Preferred lesson batch size</div>
      <div class="settings-desc">Number of new lessons to study before each quiz. May run slightly higher to avoid a small leftover batch at the end.</div>
      <select id="lessonBatchSizeInput">
        ${batchOptions.map(n=>`<option value="${n}" ${settings.lessonBatchSize===n?'selected':''}>${n}</option>`).join('')}
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Maximum daily lessons</div>
      <div class="settings-desc">Caps how many new words you'll be offered per day. 0 = no limit, 100 = maximum.</div>
      <input type="number" id="dailyLimitInput" min="0" max="100" value="${settings.dailyNewLimit}">
    </div>
    <button class="primary" onclick="saveLessonSettings()">Save</button>
    <p class="forecast" style="text-align:center;margin-top:12px;">You've started ${dailyLabel}.</p>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Review Settings</div>
    <div class="settings-row">
      <div class="settings-label">SRS update indicator</div>
      <div class="settings-desc">Show the stage change (e.g. Genin 1 → Genin 2) after each review.</div>
      <select id="srsIndicatorInput">
        <option value="yes" ${settings.showSrsIndicator?'selected':''}>Yes</option>
        <option value="no" ${!settings.showSrsIndicator?'selected':''}>No</option>
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Show the mnemonic after answering</div>
      <div class="settings-desc">Off by default. The mnemonic tells the meaning story and ends on the reading, so after a <em>correct</em> answer it stays hidden until both halves of that word are done, otherwise it hands you the half you haven't been asked yet. After a wrong one there is nothing left to give away, since missing either half already fails the item, so the mnemonic is always available there behind a button.</div>
      <select id="showMnemonicInput">
        <option value="no" ${!settings.showMnemonicOnAnswer?'selected':''}>No</option>
        <option value="yes" ${settings.showMnemonicOnAnswer?'selected':''}>Yes</option>
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Reveal the answer after a mistake</div>
      <div class="settings-desc">"Only when asked" keeps the correct answer, mnemonic and sentence translation hidden behind a button, so you get a chance to recall it yourself first. Applies to reviews, lesson quizzes and extra study.</div>
      <select id="hideAnswerInput">
        <option value="manual" ${settings.hideAnswerOnMistake?'selected':''}>Only when asked</option>
        <option value="auto" ${!settings.hideAnswerOnMistake?'selected':''}>Straight away</option>
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Review ordering</div>
      <div class="settings-desc">
        <b>Shuffled</b>, random order.<br>
        <b>Genin First</b>, review Genin-stage items first, then randomize the rest. Best when you're short on time.<br>
        <b>Lower Stages First</b>. Always review whichever due item is least-learned, Genin → Chunin → Jonin → Anbu.
      </div>
      <select id="reviewOrderInput">
        <option value="shuffled" ${settings.reviewOrder==='shuffled'?'selected':''}>Shuffled</option>
        <option value="genin-first" ${settings.reviewOrder==='genin-first'?'selected':''}>Genin First</option>
        <option value="lower-stage-first" ${settings.reviewOrder==='lower-stage-first'?'selected':''}>Lower Stages First</option>
      </select>
    </div>
    <button class="primary" onclick="saveReviewSettings()">Save</button>
  </div>
  ${renderAudioCard()}
  ${renderAccountCard()}
  ${renderDangerCard()}
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button>
  </div>
  `;
}

function renderAudioCard(){
  if(!AUDIO_ENABLED) return ''; // feature parked; see AUDIO_ENABLED
  const shippedCount = shippedAudioCount();
  const shipped = shippedCount > 0;
  // The device voice is only ever heard on a word the shipped audio misses, so
  // once it covers the deck this picker is a control that changes nothing. It
  // was the confusing half of the card: four Windows voices offered next to the
  // two that actually play. It comes back on its own if coverage ever drops,
  // which is the only state where the choice means something.
  const voices = japaneseVoices();
  const showDevicePicker = voices.length > 0 && shippedCount < VOCAB.length;
  // Only worth saying any of this when there is nothing to play. With shipped
  // audio present the device's voice situation stops being the user's problem,
  // so telling them to go and install one would be both wrong and off-putting.
  if(!shipped && !speechSupported()){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Audio</div>
      <div class="settings-desc">This browser doesn't support speech synthesis, so audio is unavailable.</div>
    </div>`;
  }
  if(!shipped && !jaVoice){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Audio</div>
      <div class="settings-desc">No Japanese voice is installed on this device, so audio buttons are hidden. On Windows add one under Settings → Time &amp; language → Language &amp; region → add Japanese. iOS and Android generally ship one already.</div>
    </div>`;
  }
  const rates = [0.6,0.7,0.8,0.9,1.0,1.1,1.2];
  if(!rates.includes(settings.speechRate)) rates.push(settings.speechRate);
  rates.sort((a,b)=>a-b);
  const source = shipped
    ? `Words are read from audio that ships with Emaki, so it sounds the same on every device and needs nothing installed.${
        shippedCount < VOCAB.length ? ` ${shippedCount} of ${VOCAB.length} words so far; the rest use your device's voice.` : ''}`
    : `Audio is spoken by your device${jaVoice ? ` using <b>${escapeHtml(jaVoice.name)}</b>` : ''}.`;
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Audio</div>
    <div class="settings-row">
      <div class="settings-desc">${source} It only appears after you've answered, never on the question itself, and it reads the word's kana rather than its characters, so it can't give you a reading the card isn't teaching.</div>
    </div>
    ${AUDIO_VOICES.length > 1 ? `
    <div class="settings-row">
      <div class="settings-label">Voice</div>
      <select id="shippedVoiceInput" onchange="chooseShippedVoice(this.value)">
        ${AUDIO_VOICES.map(v=>`<option value="${escapeHtml(v.key)}" ${settings.audioVoice===v.key?'selected':''}>${escapeHtml(v.label)}${v.gender?` (${escapeHtml(v.gender)})`:''}</option>`).join('')}
      </select>
    </div>
    <div class="settings-desc" style="margin-top:-4px;margin-bottom:10px;">
      Changing this plays a sample straight away.
    </div>` : ''}
    ${showDevicePicker ? `
    <div class="settings-row">
      <div class="settings-label">${shipped ? 'Device voice, for anything not shipped' : 'Voice'}</div>
      <select id="voiceInput" onchange="auditionVoice(this.value)">
        ${voices.map(v=>`<option value="${escapeHtml(v.name)}" ${jaVoice && jaVoice.name===v.name?'selected':''}>${escapeHtml(v.name)}${v.localService?'':' (online)'}</option>`).join('')}
      </select>
    </div>
    <div class="settings-desc" style="margin-top:-4px;margin-bottom:10px;">
      Changing this plays a sample straight away, so try them. Ones marked
      online are usually the better ones and need a connection; the others
      work offline.
    </div>` : ''}
    <div class="settings-row">
      <div class="settings-label">Play the word automatically in lessons</div>
      <select id="autoPlayInput">
        <option value="yes" ${settings.autoPlayLessonAudio?'selected':''}>Yes</option>
        <option value="no" ${!settings.autoPlayLessonAudio?'selected':''}>No</option>
      </select>
    </div>
    <div class="settings-row">
      <div class="settings-label">Speaking speed</div>
      <select id="speechRateInput">
        ${rates.map(r=>`<option value="${r}" ${settings.speechRate===r?'selected':''}>${r.toFixed(1)}×${r===DEFAULT_SETTINGS.speechRate?' (default)':''}</option>`).join('')}
      </select>
    </div>
    <button class="primary" onclick="saveAudioSettings()">Save</button>
    <p class="forecast" style="text-align:center;margin-top:12px;">
      <button class="reset-link" onclick="playAudioSample()">${shipped ? 'Play a sample word' : 'Play a test phrase'}</button>
    </p>
  </div>
  `;
}

// Sync used to be findable only by opening Settings and scrolling, which meant
// most people never learned their progress could follow them. This says so once
// on the dashboard, under the two study buttons so it never comes between
// somebody and their reviews.
//
// Dismissal lives in localStorage rather than settings: settings sync, and the
// only people who see this are the ones with nowhere to sync to.
function syncPromptDismissed(){
  try{ return window.localStorage.getItem(SYNC_PROMPT_KEY) === '1'; }catch(e){ return false; }
}
function dismissSyncPrompt(){
  try{ window.localStorage.setItem(SYNC_PROMPT_KEY, '1'); }catch(e){}
  render();
}

function renderSyncPrompt(){
  if(typeof signInWithEmail !== 'function') return '';   // sync.js absent
  // Say nothing until sync.js has actually checked for a session. app.js paints
  // first and initSync resolves a moment later, so before this the answer is
  // simply unknown, and guessing "signed out" put the prompt in front of people
  // who were signed in the whole time.
  if(typeof syncChecked === 'undefined' || !syncChecked) return '';
  if(typeof syncUser !== 'undefined' && syncUser) return ''; // already signed in
  if(syncPromptDismissed()) return '';
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Study on your other devices</div>
    <div class="settings-desc">Progress is saved in this browser only. Sign in and it follows you to your phone, and survives clearing your history.</div>
    <div class="btnrow" style="margin-top:12px;">
      <button class="secondary" onclick="dismissSyncPrompt()">Not now</button>
      <button class="primary" onclick="switchView('settings')">Sign in</button>
    </div>
  </div>`;
}

// Deleting the synced copy, as distinct from resetProgress() which only clears
// this browser. Two steps on purpose: the first click is easy to make by
// accident on a phone, and there is no undo behind it.
let deleteArmed = false;
function armDelete(){ deleteArmed = true; render(); }
function cancelDelete(){ deleteArmed = false; render(); }

async function confirmDeleteAccount(){
  if(typeof deleteRemoteData !== 'function') return;
  syncNotice = 'Deleting…';
  render();
  const res = await deleteRemoteData();
  if(!res.ok){
    deleteArmed = false;
    syncNotice = 'Could not delete: ' + res.error + ' Nothing was removed.';
    render();
    return;
  }
  // Server copy is gone and confirmed gone. Now clear this device and sign out,
  // in that order, so a failure above never leaves you locally wiped but still
  // synced on the server.
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(DAILY_KEY);
  localStorage.removeItem(MISTAKES_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
  localStorage.removeItem(REVIEW_HISTORY_KEY);
  localStorage.removeItem(STREAK_SAVE_KEY);
  // The agreed base describes a row that no longer exists.
  if(typeof clearSyncBase === 'function') clearSyncBase();
  deleteArmed = false;
  // Globally, so a device that is still signed in cannot find an empty account,
  // seed it from the copy it still holds, and undo the delete a minute later.
  await signOutSync('global');
  syncNotice = 'Deleted. Your study data is gone from this device and from the server, and every other device has been signed out. A device that still holds a copy will upload it again if you sign in there, so clear it there too if you want it gone for good.';
  location.reload();
}

function renderDangerCard(){
  if(typeof deleteRemoteData !== 'function') return '';
  if(typeof syncUser === 'undefined' || !syncUser) return '';
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Delete your data</div>
    ${deleteArmed ? `
      <div class="settings-desc">This removes every SRS level, review, mistake and streak from this device and from the server. It cannot be undone.</div>
      <div class="btnrow" style="margin-top:12px;">
        <button class="secondary" onclick="cancelDelete()">Keep it</button>
        <button class="reset-link" style="color:var(--bad,#e06c6c);" onclick="confirmDeleteAccount()">Yes, delete everything</button>
      </div>
    ` : `
      <div class="settings-desc">Removes your progress from this device and from the server, then signs you out. Your sign-in itself stays on file, because removing that needs access this app deliberately does not hold. Open an issue and it will be removed by hand.</div>
      <button class="secondary" style="margin-top:12px;" onclick="armDelete()">Delete my data</button>
    `}
  </div>`;
}

function renderAccountCard(){
  // sync.js is optional; degrade to a plain note rather than offering a button
  // that would throw.
  if(typeof signInWithEmail !== 'function'){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Sync</div>
      <div class="settings-desc">Sync is unavailable right now. Progress is being saved to this device only.</div>
    </div>`;
  }
  const notice = typeof syncNotice === 'string' && syncNotice
    ? `<p class="forecast" style="text-align:center;margin-top:12px;">${escapeHtml(syncNotice)}</p>` : '';
  const signedIn = typeof syncUser !== 'undefined' && syncUser;
  // OAuth is offered only for providers sync.js actually lists, so turning one
  // off in the Supabase dashboard means deleting it there and the button goes.
  const providers = (typeof signInWithProvider === 'function' && typeof OAUTH_PROVIDERS !== 'undefined')
    ? OAUTH_PROVIDERS : [];
  const providerButtons = providers.length ? `
      <div class="btnrow" style="flex-direction:column;gap:8px;margin-bottom:14px;">
        ${providers.map(p=>`<button class="primary" onclick="signInWithProvider('${escapeHtml(p.id)}')">${escapeHtml(p.label)}</button>`).join('')}
      </div>` : '';
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Sync</div>
    ${signedIn ? `
      <div class="settings-row">
        <div class="settings-desc">Signed in as <b>${escapeHtml(syncUser.email || '')}</b>. Progress syncs across any device you sign in on.</div>
      </div>
      <button class="primary" onclick="signOutSync()">Sign out</button>
    ` : `
      <div class="settings-row">
        <div class="settings-desc">Sign in to keep progress in step across devices. No password to remember either way. Without this, progress stays in this browser only.</div>
      </div>
      ${providerButtons}
      <div class="settings-row">
        <div class="settings-desc">Or have a one-time link emailed to you.</div>
        <input type="email" id="syncEmailInput" placeholder="you@example.com" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false">
      </div>
      <button class="secondary" onclick="signInWithEmail()">Email me a sign-in link</button>
    `}
    ${notice}
  </div>
  `;
}

function renderReview(){
  if(reviewState && reviewState.queue.length===0){
    const results = Object.values(reviewState.results);
    const total = results.length;
    const clean = results.filter(r=>!r.missed).length;
    reviewState = null;
    return `${nav('review')}<div class="empty">Review session complete: ${total} item${total===1?'':'s'} reviewed.<br>${clean} of ${total} answered correctly first time.</div>`;
  }
  if(!reviewState){
    const upcoming = nextUpcoming();
    return `${nav('review')}<div class="empty">No reviews due right now.${upcoming?`<br>Next batch unlocks in ${humanizeDuration(upcoming-now())}.`:'<br>Complete a lesson first.'}</div>`;
  }
  const q = reviewState.queue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const p = getEntry(item.id);
  const res = reviewState.results[item.id];
  const label = q.type==='meaning' ? 'Meaning' : 'Reading';
  const qClass = q.type==='meaning' ? 'q-meaning' : 'q-reading';
  const answer = q.type==='meaning' ? item.meaning : item.reading;
  // Set by commitReviewAnswer on the question that completed the item, with the
  // stage read either side of the move. It is a report of what has already been
  // written, not a forecast of what pressing Next would do, which is what it
  // used to be back when Next was the thing that committed.
  const stageChange = reviewState.stageChange;
  // queue[0] is the question on screen; anything after it is still to come.
  const holdBack = siblingPending(reviewState.queue.slice(1), item.id);
  const readingHeld = readingPending(reviewState.queue.slice(1), item.id);
  return `
  ${nav('review')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:8px;">
    <span style="font-size:12px;color:var(--text-dim);">Session ${sessionCorrect}/${sessionTotal} · ${reviewState.queue.length} left</span>
    <span style="display:flex;align-items:center;gap:6px;">
      <span class="pill" style="background:var(--${TIER_COLOR(p.stage)}-bg,var(--surface-2));color:var(--${TIER_COLOR(p.stage)});">${STAGE_NAMES[p.stage]}</span>
      <span class="pill ${qClass}">${label}</span>
    </span>
  </div>
  <div class="bigword ${qClass}">${escapeHtml(item.word)}</div>
  ${!reviewState.showAnswer ? `
    <div class="field"><div class="k">Example</div><div class="v jp">${escapeHtml(item.sentence)}</div></div>
    <input type="text" id="reviewInput" placeholder="Type the ${label.toLowerCase()}" ${ANSWER_INPUT_ATTRS}>
    <div class="btnrow">
      <button class="secondary" onclick="leaveReviewSession()">Back</button>
      <button class="primary" onclick="submitReviewAnswer()">Check</button>
    </div>
  ` : `
    <div class="field result-${reviewState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${reviewState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(reviewState) && !readingHeld ? audioBtn('speakWord', item.id, 'Play word') : ''}</div>
      ${answerVisible(reviewState) ? `<div class="v">${q.type==="meaning" ? escapeHtml(answer) : renderReading(item)}</div>` : ""}
      ${!reviewState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(reviewState)?'margin-top:6px;':''}">You typed: ${escapeHtml(reviewState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${settings.showSrsIndicator && stageChange ? `<p class="forecast" style="text-align:center;">${STAGE_NAMES[stageChange.from]} → ${STAGE_NAMES[stageChange.to]}</p>` : ''}
    ${answerVisible(reviewState) ? `
      ${stageChange ? completedCard(item, q.type) : ''}
      <div class="field"><div class="k">Example</div><div class="v jp">${escapeHtml(item.sentence)}</div>${holdBack ? '' : `<div class="v" style="font-size:13px;color:var(--text-dim);margin-top:4px;">${escapeHtml(item.sentence_meaning)}</div>`}</div>
    ` : `
      <button class="secondary" onclick="revealReviewAnswer()">Show answer</button>
    `}
    ${stageChange ? '' : mnemonicPanel(reviewState, item, holdBack, 'review')}
    <div class="btnrow">
      <button class="secondary" onclick="leaveReviewSession()">Back</button>
      <button class="primary" onclick="advanceReview()">Next</button>
    </div>
  `}
  `;
}

function renderExtraStudy(){
  if(!extraStudyState || extraStudyState.index >= extraStudyState.queue.length){
    const done = extraStudyState ? extraStudyState.wordCount : 0;
    extraStudyState = null;
    return `<div class="empty">Extra study complete: ${done} word${done===1?'':'s'} practiced.<br>This doesn't change their SRS timing, just extra reps.</div><div style="text-align:center;margin-top:10px;"><button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button></div>`;
  }
  const q = extraStudyState.queue[extraStudyState.index];
  const item = VOCAB.find(v=>v.id===q.id);
  const label = q.type==='meaning' ? 'Meaning' : 'Reading';
  const qClass = q.type==='meaning' ? 'q-meaning' : 'q-reading';
  const answer = q.type==='meaning' ? item.meaning : item.reading;
  const holdBack = siblingPending(extraStudyState.queue.slice(extraStudyState.index+1), item.id);
  const readingHeld = readingPending(extraStudyState.queue.slice(extraStudyState.index+1), item.id);
  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
    <span style="font-size:12px;color:var(--text-dim);">Extra Study · ${extraStudyState.index+1} of ${extraStudyState.queue.length}</span>
    <span style="display:flex;align-items:center;gap:8px;">
      <span class="pill ${qClass}">${label}</span>
      <button class="reset-link" onclick="switchView('dashboard')">End session</button>
    </span>
  </div>
  <div class="bigword ${qClass}">${escapeHtml(item.word)}</div>
  <div class="field"><div class="k">Example</div><div class="v jp">${escapeHtml(item.sentence)}</div></div>
  ${!extraStudyState.showAnswer ? `
    <input type="text" id="extraInput" placeholder="Type the ${label.toLowerCase()}" ${ANSWER_INPUT_ATTRS}>
    <button class="primary" onclick="submitExtraStudyAnswer()">Check</button>
  ` : `
    <div class="field result-${extraStudyState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${extraStudyState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(extraStudyState) && !readingHeld ? audioBtn('speakWord', item.id, 'Play word') : ''}</div>
      ${answerVisible(extraStudyState) ? `<div class="v">${q.type==="meaning" ? escapeHtml(answer) : renderReading(item)}</div>` : ""}
      ${!extraStudyState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(extraStudyState)?'margin-top:6px;':''}">You typed: ${escapeHtml(extraStudyState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${answerVisible(extraStudyState) ? '' : `
      <button class="secondary" onclick="revealExtraStudyAnswer()">Show answer</button>
    `}
    ${mnemonicPanel(extraStudyState, item, holdBack, 'extra')}
    <button class="primary" onclick="advanceExtraStudy()">Next</button>
  `}
  `;
}

function render(){
  const root = document.getElementById('root');
  // A drag in progress is holding elements that are about to be replaced.
  if(typeof cancelSectionDrag === 'function') cancelSectionDrag();
  let body;
  if(view==='welcome') body = renderWelcome();
  else if(view==='dashboard') body = renderDashboard();
  else if(view==='lessons') body = renderLessons();
  else if(view==='tierlist') body = renderTierList();
  else if(view==='item') body = renderItemDetail();
  else if(view==='settings') body = renderSettings();
  else if(view==='info') body = renderInfo();
  else if(view==='extrastudy') body = renderExtraStudy();
  else body = renderReview();
  root.innerHTML = `
    <header>
      <h1>Emaki</h1>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="sub">1500-word deck</span>
        ${view==='dashboard' ? `<button class="icon-btn${arrangingDashboard?' on':''}" onclick="toggleArrangingDashboard()"
          title="${arrangingDashboard?'Finish arranging':'Arrange the dashboard'}"
          aria-label="${arrangingDashboard?'Finish arranging the dashboard':'Arrange the dashboard'}"
          aria-pressed="${arrangingDashboard?'true':'false'}">⠿</button>` : ''}
        <button class="icon-btn" onclick="navTo('info')" title="Info" aria-label="Info">ⓘ</button>
        <button class="icon-btn" onclick="navTo('settings')" title="Settings" aria-label="Settings">⚙</button>
      </div>
    </header>
    ${body}
  `;
  // Moving a section with the keyboard redraws the whole dashboard, which
  // throws the focus back to the body and leaves somebody arranging by keyboard
  // with nothing selected after every single press. Whoever asked for the
  // redraw says where the focus should land after it.
  if(focusAfterRender){
    const target = root.querySelector(focusAfterRender);
    focusAfterRender = null;
    if(target) target.focus();
  }
  const input = document.getElementById('reviewInput')
    || document.getElementById('quizInput')
    || document.getElementById('extraInput');
  if(input){
    input.focus();
    // Reading questions get romaji->kana conversion so no OS-level Japanese
    // IME is needed. Reviews and extra study ask readings too now, not just
    // the lesson quiz.
    if(currentQuestionType()==='reading' && window.wanakana){
      window.wanakana.bind(input, { IMEMode: true });
    }
  }
}

// Which half of an item the on-screen question is asking, if any.
function currentQuestionType(){
  if(view==='lessons' && lessonState && lessonState.phase==='quiz' && lessonState.quizQueue.length>0){
    return lessonState.quizQueue[0].type;
  }
  if(view==='review' && reviewState && reviewState.queue.length>0){
    return reviewState.queue[0].type;
  }
  if(view==='extrastudy' && extraStudyState && extraStudyState.index < extraStudyState.queue.length){
    return extraStudyState.queue[extraStudyState.index].type;
  }
  return null;
}

// Capture phase so this runs before wanakana's own keydown handling on
// #quizInput, otherwise wanakana swallows Enter (and clears the field)
// before our submit/advance logic ever sees it.
document.addEventListener('keydown', (e)=>{
  if(e.key !== 'Enter') return;
  if(view==='lessons' && lessonState && lessonState.phase==='quiz'){
    if(!lessonState.showAnswer && document.getElementById('quizInput')){
      e.preventDefault();
      e.stopPropagation();
      submitQuizAnswer();
    }else if(lessonState.showAnswer){
      e.preventDefault();
      answerQuizQuestion(lessonState.lastCorrect);
    }
  }else if(view==='review' && reviewState && reviewState.queue.length>0){
    if(!reviewState.showAnswer && document.getElementById('reviewInput')){
      e.preventDefault();
      e.stopPropagation();
      submitReviewAnswer();
    }else if(reviewState.showAnswer){
      e.preventDefault();
      advanceReview();
    }
  }else if(view==='extrastudy' && extraStudyState){
    if(!extraStudyState.showAnswer && document.getElementById('extraInput')){
      e.preventDefault();
      e.stopPropagation();
      submitExtraStudyAnswer();
    }else if(extraStudyState.showAnswer){
      e.preventDefault();
      advanceExtraStudy();
    }
  }
}, true);

async function init(){
  loadProgress();
  loadSettings();
  // Straight after the settings load and before the first render, so the
  // choice is never briefly overridden by the default.
  applyTheme();
  watchSystemTheme();
  loadDailyLessons();
  loadMistakes();
  loadActivity();
  loadStreakSaves();
  loadReviewHistory();
  refreshStreakSaves();
  initSpeech();
  try{
    const res = await fetch('data/vocab.json');
    VOCAB = await res.json();
    // Component data is a nice-to-have; a failure here must not stop lessons.
    try{
      const kres = await fetch('data/kanji.json');
      KANJI = await kres.json();
    }catch(e){ KANJI = {}; }
    // Same again for the audio manifest, which is empty until gen-audio.pl has
    // been run and partial while it is being run. Either way the app falls back
    // to the device voice, so this must never be allowed to throw.
    // Same again for the pitch data: a card with no entry simply shows a plain
    // reading, so a failure here costs the pattern and nothing else.
    try{
      const pres = await fetch('data/pitch.json');
      if(pres.ok){
        const pitch = await pres.json();
        if(pitch && pitch.pitch) PITCH = pitch.pitch;
      }
    }catch(e){ PITCH = {}; }
    try{
      const ares = await fetch('data/audio.json');
      if(ares.ok){
        const manifest = await ares.json();
        AUDIO_VOICES = Array.isArray(manifest.voices) ? manifest.voices : [];
        AUDIO_IDS = {};
        if(manifest.ids){
          for(const key of Object.keys(manifest.ids)){
            if(Array.isArray(manifest.ids[key])) AUDIO_IDS[key] = new Set(manifest.ids[key]);
          }
        }
        // A preference pointing at a voice that was never generated would mean
        // silence for every word the other voice does have.
        if(settings.audioVoice && !AUDIO_IDS[settings.audioVoice]) settings.audioVoice = null;
        if(!settings.audioVoice && AUDIO_VOICES.length) settings.audioVoice = AUDIO_VOICES[0].key;
      }
    }catch(e){ AUDIO_VOICES = []; AUDIO_IDS = {}; }
  }catch(e){
    document.getElementById('root').innerHTML = '<div class="empty">Failed to load vocab data. Make sure data/vocab.json is reachable (serve this over http, not file://).</div>';
    return;
  }
  // Decided after the deck loads, because the welcome page quotes how many
  // words are ready. Anyone with progress goes straight to the dashboard, and
  // a returning signed-in user on a new device gets it too once sync pulls
  // their progress down.
  // #welcome opens the intro whatever your progress, so the link works for
  // somebody who already uses the app and is sending it to a friend.
  if(window.location.hash === '#welcome' || isNewHere()) view = 'welcome';
  render();
  lastRenderedDay = todayKey();
  scheduleMidnightCheck();
  window.addEventListener("storage", adoptOtherTabWrite);
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "visible") refreshForNewDay();
  });
  // Sync is best-effort and must never block the app from being usable.
  if(typeof initSync === 'function'){
    initSync().catch(()=>{});
  }
}

// ---- The day turning over --------------------------------------------------
// Everything dated is computed during render(), and nothing re-rendered on its
// own, so a dashboard left open overnight kept yesterday's numbers under
// today's labels: "Today 60, Yesterday 0" when a fresh render would have said
// "Today 0, Yesterday 60". It looks exactly like a lost day of reviews, and it
// is why Lasz reported one.
//
// A timer alone is not enough. Browsers throttle them in background tabs and
// stop them entirely when a laptop sleeps, which is precisely the tab that will
// have been open across midnight. So the date is also checked whenever the page
// becomes visible again.
let lastRenderedDay = todayKey();

function dayChanged(){
  if(todayKey() === lastRenderedDay) return false;
  lastRenderedDay = todayKey();
  return true;
}

// Refreshes only what is date-dependent, and only when the screen is showing
// it. Redrawing mid-review would throw away a half-typed answer for the sake of
// a number the user is not looking at.
function refreshForNewDay(){
  if(!dayChanged()) return;
  refreshStreakSaves();
  if(view === 'dashboard' || view === 'tierlist' || view === 'item') render();
}

function scheduleMidnightCheck(){
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  // Half a minute past, so a clock a little behind ours has also turned over.
  setTimeout(()=>{ refreshForNewDay(); scheduleMidnightCheck(); },
             Math.max(1000, midnight - now));
}

// ---- Another tab writing underneath us -------------------------------------
// Each tab loads its state once and then writes the whole object back. Two tabs
// open across a day meant the older one could overwrite the newer one's work
// wholesale: tab B, opened yesterday and holding an empty history, records one
// review today and writes back its stale copy, erasing everything tab A did.
// The storage event fires in the *other* tabs, so this is where that is caught.
function adoptOtherTabWrite(e){
  if(!e || !e.newValue) return;
  try{
    if(e.key === REVIEW_HISTORY_KEY)      reviewHistory = JSON.parse(e.newValue);
    else if(e.key === ACTIVITY_KEY)       activityDates = JSON.parse(e.newValue);
    else if(e.key === STORAGE_KEY)        progress      = JSON.parse(e.newValue);
    else if(e.key === STREAK_SAVE_KEY)    streakSaves   = JSON.parse(e.newValue);
    else if(e.key === DAILY_KEY)          dailyLessons  = JSON.parse(e.newValue);
    else return;
  }catch(err){ return; }   // a half-written value is not worth acting on
  // Same restraint as the day rollover: do not redraw a screen someone is
  // answering a question on.
  if(view === 'dashboard' || view === 'tierlist') render();
}

init();
