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
  speechRate: 0.9,          // a touch under natural pace reads clearer
  autoPlayLessonAudio: true,
  hideAnswerOnMistake: true, // make yourself recall it before it's handed over
  showMnemonicOnAnswer: false // the mnemonic gives away the half you haven't been asked yet
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
const meaningCore = s => s.replace(/^to /, '');

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
// OFF for now. Handing the synthesiser a bare kanji makes it guess the reading,
// and it guesses by frequency rather than by what the card teaches. 人 came
// out as ひと on a card teaching じん, which trains the wrong reading. The
// device voices also run fast enough to be hard to follow at 0.9x.
//
// Flip this to true to bring the whole feature back. The likely fix when we
// return: speak item.reading (kana, unambiguous) instead of item.word, and
// drop the default rate.
const AUDIO_ENABLED = false;

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
  // Prefer a voice the platform marks as local: network voices cut out offline
  // and lag behind the tap that triggered them.
  jaVoice = ja.find(v=>v.localService) || ja[0];
  return jaVoice;
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

function speakWord(id){
  const item = VOCAB.find(v=>v.id===id);
  if(item) speakJa(item.word);
}
function speakSentence(id){
  const item = VOCAB.find(v=>v.id===id);
  if(item) speakJa(item.sentence);
}

// Small speaker button; renders to nothing when no Japanese voice is installed.
function audioBtn(fn, id, label){
  if(!canSpeak()) return '';
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
  if(streakSaves.count >= STREAK_SAVE_MAX){
    streakSaves.lastEarned = todayKey();
    return;
  }
  const elapsed = daysSince(streakSaves.lastEarned);
  if(elapsed >= STREAK_SAVE_DAYS){
    streakSaves.count = Math.min(STREAK_SAVE_MAX, streakSaves.count + Math.floor(elapsed/STREAK_SAVE_DAYS));
    streakSaves.lastEarned = todayKey();
  }
}

// Spends kunai on days you missed, so studyStreak() reads them as covered.
// Only bridges gaps that sit between earlier activity and today. It will never
// spend one to invent a streak you never had.
function applyStreakSaves(){
  if(activityDates.length === 0) return;
  const earliest = activityDates.slice().sort()[0];
  const covered = new Set(activityDates.concat(streakSaves.savedDates));
  let d = addDays(new Date(), -1);
  let guard = 0;
  while(streakSaves.count > 0 && guard < 40){
    guard++;
    const key = dateKey(d);
    if(key < earliest) break;      // nothing before this to keep alive
    if(covered.has(key)){ d = addDays(d, -1); continue; }
    streakSaves.count--;
    streakSaves.savedDates.push(key);
    covered.add(key);
    d = addDays(d, -1);
  }
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
  saveProgress();
}

function completeLesson(id){
  progress[id] = {
    stage: 1,
    nextReview: now() + INTERVAL_HOURS[1]*3600*1000,
    unlocked: now(),
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

function answerQuizQuestion(correct){
  const q = lessonState.quizQueue.shift();
  if(correct){
    lessonState.quizProgress[q.id][q.type] = true;
    if(lessonState.quizProgress[q.id].meaning && lessonState.quizProgress[q.id].reading){
      completeLesson(q.id);
    }
  }else{
    const insertAt = Math.min(lessonState.quizQueue.length, 3);
    lessonState.quizQueue.splice(insertAt, 0, q);
  }
  lessonState.showAnswer = false;
  lessonState.revealed = false;
  lessonState.mnemonicShown = false;
  render();
}

function submitQuizAnswer(){
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
  saveProgress();
  recordActivityToday();
  recordReviewCompleted();
}

// After a wrong answer the correct one stays hidden until asked for, so the
// recall attempt isn't short-circuited. Anything that would give it away, 
// the mnemonic, the sentence translation. Is withheld along with it.
function answerVisible(state){
  return state.lastCorrect || state.revealed || !settings.hideAnswerOnMistake;
}

// Every item is asked twice, meaning and reading, interleaved in one queue. So
// the panel shown after answering one half can hand over the other half before
// it's been asked: the sentence translation is the meaning in English, and the
// mnemonic gives away both. It tells the meaning story and signs off with the
// reading in kana. Only reveal those once the sibling question is out of the
// queue. `rest` is whatever is still to come, current question excluded.
function siblingPending(rest, id){
  return rest.some(x => x.id === id);
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
function mnemonicPanel(state, item, holdBack, which){
  if(!answerVisible(state) || !item.mnemonic) return '';
  const field = `<div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>`;
  if(state.lastCorrect) return settings.showMnemonicOnAnswer && !holdBack ? field : '';
  if(settings.showMnemonicOnAnswer || state.mnemonicShown) return field;
  return `<div style="text-align:center;margin-bottom:10px;">
    <button class="secondary" onclick="revealMnemonic('${which}')">Show mnemonic</button>
  </div>`;
}

function submitReviewAnswer(){
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
  render();
}

function advanceReview(){
  const q = reviewState.queue.shift();
  const res = reviewState.results[q.id];
  sessionTotal++;
  if(reviewState.lastCorrect){
    sessionCorrect++;
    // Count the first attempt only. Getting it right on the retry after a miss
    // is still a miss for this review, which is how the percentage stays
    // meaningful rather than drifting to 100% for everybody.
    if(!res[q.type] && !res[q.type+'Missed']) recordAnswer(q.id, q.type, true);
    res[q.type] = true;
    if(res.meaning && res.reading) applyReviewResult(q.id, !res.missed);
  }else{
    if(!res[q.type+'Missed']){
      res[q.type+'Missed'] = true;
      res.missed = true;
      recordAnswer(q.id, q.type, false);
      recordMistake(q.id, q.type);
    }
    const insertAt = Math.min(reviewState.queue.length, 3);
    reviewState.queue.splice(insertAt, 0, q);
  }
  reviewState.showAnswer = false;
  reviewState.lastCorrect = null;
  reviewState.lastInput = '';
  reviewState.revealed = false;
  reviewState.mnemonicShown = false;
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
  switchView('dashboard');
}

function nav(active){
  const due = dueReviews().length;
  const lessons = Math.min(newWords().length, remainingToday());
  return `<nav>
    <button onclick="switchView('dashboard')" class="${active==='dashboard'?'active':''}">Dashboard</button>
    <button onclick="switchView('lessons')" class="${active==='lessons'?'active':''}">Lessons (${lessons})</button>
    <button onclick="switchView('review')" class="${active==='review'?'active':''}">Reviews (${due})</button>
  </nav>`;
}

function renderDashboard(){
  const counts = {new:0,genin:0,chunin:0,jonin:0,anbu:0,kage:0};
  VOCAB.forEach(v=>{
    const p = getEntry(v.id);
    counts[TIER_COLOR(p.stage)]++;
  });
  const due = dueReviews().length;
  const upcoming = nextUpcoming();
  const lessonsAvailable = Math.min(newWords().length, remainingToday());
  const learnableCount = learnableWords().length;

  const mistakeItems = recentMistakeIds().map(id=>VOCAB.find(v=>v.id===id)).filter(Boolean);

  const todayCount = reviewsCompletedOn();
  const yesterdayCount = reviewsCompletedOn(addDays(new Date(), -1));

  refreshStreakSaves();
  const streak = studyStreak();

  return `
  ${nav('dashboard')}
  <div class="grid2">
    <div class="card cta-card">
      <div class="cta-label">Reviews</div>
      <div class="cta-count">${due}</div>
      <div class="cta-sub">${due>0 ? 'Reviews are ready.' : (upcoming ? `Next batch in ${humanizeDuration(upcoming-now())}` : 'All caught up.')}</div>
      <button class="primary" onclick="switchView('review')">Start Reviews</button>
    </div>
    <div class="card cta-card">
      <div class="cta-label">Today's Lessons</div>
      <div class="cta-count">${lessonsAvailable}</div>
      <div class="cta-sub">${lessonsAvailable>0 ? 'Learn something new.' : 'None available right now.'}</div>
      <button class="primary" onclick="switchView('lessons')">Start Lessons</button>
    </div>
  </div>
  ${renderSyncPrompt()}
  ${renderSearchCard()}
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
  </div>
  <div class="grid2">
    <div class="card stat-card">
      <div class="section-title">Reviews Today</div>
      <div class="cta-count">${todayCount}</div>
      <div class="cta-sub">Yesterday: ${yesterdayCount}</div>
    </div>
    <div class="card stat-card">
      <div class="section-title">Study Streak</div>
      <div class="cta-count">${streak}</div>
      <div class="cta-sub">${streak>0 ? `day${streak===1?'':'s'} in a row` : 'study today to start one'}</div>
      <div class="kunai ${streakSaves.count>0?'held':'spent'}">
        <svg class="kunai-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="3.1" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11.2" y="5.2" width="1.6" height="3.6" fill="currentColor"/><path d="M12 8.6 L15.4 12.4 L12 23 L8.6 12.4 Z" fill="currentColor"/></svg>
        <span>${streakSaves.count>0 ? 'Kunai ready' : 'Kunai spent'}</span>
      </div>
      <div class="kunai-note">${streakSaves.count>0
        ? `Miss a day and this covers it. A new one ${STREAK_SAVE_DAYS} days after it's used.`
        : `It covered a missed day.<br>New kunai ${formatStamp(nextKunaiAt())}.`}</div>
    </div>
  </div>
  <div class="grid3">
    ${['new','genin','chunin','jonin','anbu','kage'].map(t=>`
      <button class="stat stat-btn" onclick="showTier('${t}')" title="Show these words">
        <div class="n">${counts[t]}</div><div class="l">${t.charAt(0).toUpperCase()+t.slice(1)}</div>
      </button>`).join('')}
  </div>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="resetProgress()">Reset all progress</button>
  </div>
  `;
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

  const tiles = items.slice(0, CAP).map(v=>{
    const p = getEntry(v.id);
    const due = p.nextReview == null
      ? (p.stage === 9 ? 'burned' : 'not started')
      : (p.nextReview <= t ? 'due now' : 'in ' + humanizeDuration(p.nextReview - t));
    const hint = `${v.reading}, ${v.meaning}\n${STAGE_NAMES[p.stage]}, ${due}`;
    return `<button class="tile tile-btn jp" style="background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});border-color:var(--${tier});"
      onclick="showItem(${v.id})" title="${escapeHtml(hint)}">${escapeHtml(v.word)}</button>`;
  }).join('');

  return `
  ${nav('dashboard')}
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">${label}</div>
    <div class="forecast" style="margin-top:-4px;margin-bottom:12px;">
      ${items.length} word${items.length===1?'':'s'}${items.length > CAP ? `, showing the first ${CAP}` : ''}.
      ${tier === 'new'
        ? 'Ready to learn but not started. Tap one to read its card.'
        : 'Soonest due first. Tap one to read its card.'}
    </div>
    ${items.length === 0
      ? `<div class="empty" style="padding:16px 0;">Nothing at this rank yet.</div>`
      : `<div class="tilegrid">${tiles}</div>`}
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
    <span class="word-line">${escapeHtml(item.word)}</span>
    <div class="jp" style="font-size:20px;color:var(--text-dim);margin-top:10px;">${escapeHtml(item.reading)}</div>
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
  </div>
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
    <b>Kunai.</b> You hold one at a time. Miss a day and it's spent automatically to keep your
    study streak alive, you'll see it marked as spent on the dashboard. A replacement arrives
    ${STREAK_SAVE_DAYS} days later, so missing two days close together will still break the streak.<br><br>
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
    <div class="jp" style="font-size:20px;color:var(--text-dim);margin-top:10px;">${escapeHtml(item.reading)}</div>
  </div>
  <div class="field"><div class="k">Meaning</div><div class="v">${escapeHtml(item.meaning)}</div></div>
  ${renderKanjiParts(item.word)}
  <div class="field"><div class="k">Mnemonic</div><div class="v mnem">${escapeHtml(item.mnemonic)}</div></div>
  ${item.notes ? `<div class="field" style="background:var(--kage-bg);"><div class="k" style="color:var(--kage);">Usage note</div><div class="v" style="font-size:13px;">${escapeHtml(item.notes)}</div></div>` : ''}
  <div class="field"><div class="k">Example${audioBtn('speakSentence', item.id, 'Play sentence')}</div><div class="v jp" style="margin-bottom:4px;">${escapeHtml(item.sentence)}</div><div class="v" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.sentence_meaning)}</div></div>
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
      <div class="k">${lessonState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(lessonState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(lessonState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(q.type==='meaning'?item.meaning:item.reading)}</div>` : ''}
      ${!lessonState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(lessonState)?'margin-top:6px;':''}">You typed: ${escapeHtml(lessonState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${mnemonicPanel(lessonState, item, holdBack, 'lesson')}
    ${answerVisible(lessonState) ? '' : `
      <button class="secondary" onclick="revealQuizAnswer()">Show answer</button>
    `}
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
  return `
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
  if(!speechSupported()){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Audio</div>
      <div class="settings-desc">This browser doesn't support speech synthesis, so audio is unavailable.</div>
    </div>`;
  }
  if(!jaVoice){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Audio</div>
      <div class="settings-desc">No Japanese voice is installed on this device, so audio buttons are hidden. On Windows add one under Settings → Time &amp; language → Language &amp; region → add Japanese. iOS and Android generally ship one already.</div>
    </div>`;
  }
  const rates = [0.6,0.7,0.8,0.9,1.0,1.1,1.2];
  if(!rates.includes(settings.speechRate)) rates.push(settings.speechRate);
  rates.sort((a,b)=>a-b);
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Audio</div>
    <div class="settings-row">
      <div class="settings-desc">Using <b>${escapeHtml(jaVoice.name)}</b>. Audio is spoken by your device, so it only appears after you've answered, never on the question itself.</div>
    </div>
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
        ${rates.map(r=>`<option value="${r}" ${settings.speechRate===r?'selected':''}>${r.toFixed(1)}×${r===0.9?' (default)':''}</option>`).join('')}
      </select>
    </div>
    <button class="primary" onclick="saveAudioSettings()">Save</button>
    <p class="forecast" style="text-align:center;margin-top:12px;">
      <button class="reset-link" onclick="speakJa('日本語を勉強しています。')">Play a test phrase</button>
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
  deleteArmed = false;
  await signOutSync();
  syncNotice = 'Deleted. Your study data is gone from this device and from the server.';
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
  // Only preview the stage change on the question that completes the item, 
  // before that nothing is committed, so promising a change would be a lie.
  const completesItem = reviewState.showAnswer && reviewState.lastCorrect &&
    (q.type==='meaning' ? res.reading : res.meaning);
  const newStagePreview = completesItem ? computeReviewStage(p.stage, !res.missed) : null;
  // queue[0] is the question on screen; anything after it is still to come.
  const holdBack = siblingPending(reviewState.queue.slice(1), item.id);
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
  <div class="field"><div class="k">Example</div><div class="v jp">${escapeHtml(item.sentence)}</div></div>
  ${!reviewState.showAnswer ? `
    <input type="text" id="reviewInput" placeholder="Type the ${label.toLowerCase()}" ${ANSWER_INPUT_ATTRS}>
    <button class="primary" onclick="submitReviewAnswer()">Check</button>
  ` : `
    <div class="field result-${reviewState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${reviewState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(reviewState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(reviewState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(answer)}</div>` : ''}
      ${!reviewState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(reviewState)?'margin-top:6px;':''}">You typed: ${escapeHtml(reviewState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${settings.showSrsIndicator && completesItem ? `<p class="forecast" style="text-align:center;">${STAGE_NAMES[p.stage]} → ${STAGE_NAMES[newStagePreview]}</p>` : ''}
    ${answerVisible(reviewState) ? `
      <div class="field"><div class="k">Example${audioBtn('speakSentence', item.id, 'Play sentence')}</div><div class="v jp">${escapeHtml(item.sentence)}</div>${holdBack ? '' : `<div class="v" style="font-size:13px;color:var(--text-dim);margin-top:4px;">${escapeHtml(item.sentence_meaning)}</div>`}</div>
      ${mnemonicPanel(reviewState, item, holdBack, 'review')}
    ` : `
      <button class="secondary" onclick="revealReviewAnswer()">Show answer</button>
    `}
    <button class="primary" onclick="advanceReview()">Next</button>
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
      <div class="k">${extraStudyState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(extraStudyState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(extraStudyState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(answer)}</div>` : ''}
      ${!extraStudyState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(extraStudyState)?'margin-top:6px;':''}">You typed: ${escapeHtml(extraStudyState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${mnemonicPanel(extraStudyState, item, holdBack, 'extra')}
    ${answerVisible(extraStudyState) ? '' : `
      <button class="secondary" onclick="revealExtraStudyAnswer()">Show answer</button>
    `}
    <button class="primary" onclick="advanceExtraStudy()">Next</button>
  `}
  `;
}

function render(){
  const root = document.getElementById('root');
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
        <button class="icon-btn" onclick="switchView('info')" title="Info" aria-label="Info">ⓘ</button>
        <button class="icon-btn" onclick="switchView('settings')" title="Settings" aria-label="Settings">⚙</button>
      </div>
    </header>
    ${body}
  `;
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
  // Sync is best-effort and must never block the app from being usable.
  if(typeof initSync === 'function'){
    initSync().catch(()=>{});
  }
}

init();
