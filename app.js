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
  hideAnswerOnMistake: true // make yourself recall it before it's handed over
};
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

function levenshtein(a, b){
  const m = a.length, n = b.length;
  if(m===0) return n;
  if(n===0) return m;
  const dp = new Array(n+1);
  for(let j=0;j<=n;j++) dp[j] = j;
  for(let i=1;i<=m;i++){
    let prev = dp[0];
    dp[0] = i;
    for(let j=1;j<=n;j++){
      const tmp = dp[j];
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev + (a[i-1]===b[j-1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

// Meanings like "I (polite, general)" or "he, him" can have several
// acceptable answers — split out synonyms and drop parenthetical notes.
function meaningCandidates(meaning){
  const stripped = meaning.replace(/\([^)]*\)/g, '').trim();
  const source = stripped || meaning;
  const candidates = source.split(/[,/]/).map(s=>s.trim().toLowerCase()).filter(Boolean);
  candidates.push(meaning.trim().toLowerCase());
  return candidates;
}

function fuzzyMatch(input, candidate){
  if(input === candidate) return true;
  if(candidate.length <= 3) return false; // too short to safely allow typos
  const dist = levenshtein(input, candidate);
  const threshold = candidate.length <= 5 ? 1 : candidate.length <= 9 ? 2 : 3;
  return dist <= threshold;
}

function checkMeaning(userInput, meaning){
  const whole = userInput.trim().toLowerCase().replace(/\s+/g, ' ');
  if(!whole) return false;
  const correctCandidates = meaningCandidates(meaning);
  // Try the whole answer first. This is what accepts an exact copy of a
  // stored meaning whose own parentheses contain commas, e.g. typing
  // "I (polite, general)" — splitting that on commas would match nothing.
  if(correctCandidates.some(c => fuzzyMatch(whole, c))) return true;
  // Otherwise treat it as a list of synonyms, so "like, fond of" is accepted
  // for "fond of, liked". Every part must be a valid synonym — that keeps
  // "he, cat" from passing for "he, him" on the strength of "he" alone.
  const parts = whole.split(/[,/]/).map(s=>s.trim()).filter(Boolean);
  if(parts.length < 2) return false;
  return parts.every(p => correctCandidates.some(c => fuzzyMatch(p, c)));
}

function checkReading(userInput, reading){
  const raw = userInput.trim();
  const input = window.wanakana ? window.wanakana.toHiragana(raw) : raw;
  return reading.split('・').map(s=>s.trim()).includes(input);
}

// sync.js is optional — if it failed to load (offline, CDN blocked, or the
// user never set sync up) the app must carry on as a local-only tool.
function flagSync(){ if(typeof markDirty === 'function') markDirty(); }

// ---- Speech ---------------------------------------------------------------
// Audio comes from the browser's own Japanese voice rather than shipped files.
//
// OFF for now. Handing the synthesiser a bare kanji makes it guess the reading,
// and it guesses by frequency rather than by what the card teaches — 人 came
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
    // turns up — otherwise they'd stay hidden until the next navigation.
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
// whichever half of it you got wrong — meaning and reading are two halves of
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

// Consecutive days with activity, counting back from today. A day that
// hasn't happened yet (no activity today) doesn't break yesterday's streak.
function studyStreak(){
  const set = new Set(activityDates);
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

function completeLesson(id){
  progress[id] = { stage:1, nextReview: now() + INTERVAL_HOURS[1]*3600*1000 };
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
  render();
}

function submitQuizAnswer(){
  const q = lessonState.quizQueue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('quizInput');
  const value = input ? input.value : '';
  if(!value.trim()) return; // don't let a stray Enter count as a wrong answer
  const correct = q.type==='meaning' ? checkMeaning(value, item.meaning) : checkReading(value, item.reading);
  lessonState.showAnswer = true;
  lessonState.lastCorrect = correct;
  lessonState.lastInput = value;
  lessonState.revealed = false;
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
  settings.showSrsIndicator = indicatorEl.value === 'yes';
  settings.reviewOrder = orderEl.value;
  settings.hideAnswerOnMistake = hideEl.value === 'manual';
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
// mode — ordering only decides which items come earlier, never which half
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
// way — same contract as WaniKani.
function applyReviewResult(id, allCorrect){
  const newStage = computeReviewStage(getEntry(id).stage, allCorrect);
  const nextReview = newStage===9 ? null : now() + INTERVAL_HOURS[newStage]*3600*1000;
  progress[id] = { stage:newStage, nextReview };
  saveProgress();
  recordActivityToday();
  recordReviewCompleted();
}

// After a wrong answer the correct one stays hidden until asked for, so the
// recall attempt isn't short-circuited. Anything that would give it away —
// the mnemonic, the sentence translation — is withheld along with it.
function answerVisible(state){
  return state.lastCorrect || state.revealed || !settings.hideAnswerOnMistake;
}

function revealReviewAnswer(){ reviewState.revealed = true; render(); }
function revealExtraStudyAnswer(){ extraStudyState.revealed = true; render(); }
function revealQuizAnswer(){ lessonState.revealed = true; render(); }

function submitReviewAnswer(){
  const q = reviewState.queue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('reviewInput');
  const value = input ? input.value : '';
  if(!value.trim()) return; // don't let a stray Enter demote the item
  reviewState.lastCorrect = q.type==='meaning'
    ? checkMeaning(value, item.meaning)
    : checkReading(value, item.reading);
  reviewState.lastInput = value;
  reviewState.showAnswer = true;
  reviewState.revealed = false;
  render();
}

function advanceReview(){
  const q = reviewState.queue.shift();
  const res = reviewState.results[q.id];
  sessionTotal++;
  if(reviewState.lastCorrect){
    sessionCorrect++;
    res[q.type] = true;
    if(res.meaning && res.reading) applyReviewResult(q.id, !res.missed);
  }else{
    if(!res[q.type+'Missed']){
      res[q.type+'Missed'] = true;
      res.missed = true;
      recordMistake(q.id, q.type);
    }
    const insertAt = Math.min(reviewState.queue.length, 3);
    reviewState.queue.splice(insertAt, 0, q);
  }
  reviewState.showAnswer = false;
  reviewState.lastCorrect = null;
  reviewState.lastInput = '';
  reviewState.revealed = false;
  render();
}

function startExtraStudy(){
  const ids = recentMistakeIds();
  if(ids.length===0) return;
  // Drill each missed word as a whole — both halves, interleaved — since a
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
    ? checkMeaning(value, item.meaning)
    : checkReading(value, item.reading);
  extraStudyState.lastInput = value;
  extraStudyState.showAnswer = true;
  extraStudyState.revealed = false;
  render();
}

function advanceExtraStudy(){
  extraStudyState.index++;
  extraStudyState.showAnswer = false;
  extraStudyState.revealed = false;
  render();
}

function switchView(v){
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
  reviewHistory = {};
  dailyLessons = { date: todayKey(), count: 0 };
  sessionCorrect=0; sessionTotal=0;
  lessonState = null;
  reviewState = null;
  extraStudyState = null;
  saveProgress();
  saveMistakes();
  saveActivity();
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
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title">Recent Mistakes</div>
    <div class="forecast" style="margin-top:-4px;margin-bottom:12px;">From the past 24 hours.</div>
    ${mistakeItems.length===0 ? `<div class="empty" style="padding:16px 0;">No recent mistakes. Nice work.</div>` : `
      <div class="tilegrid">
        ${mistakeItems.slice(0, MISTAKE_TILE_LIMIT).map(item=>{
          const tier = TIER_COLOR(getEntry(item.id).stage);
          return `<span class="tile" style="background:var(--${tier}-bg,var(--surface-2));color:var(--${tier});border-color:var(--${tier});" title="${escapeHtml(item.reading + ' — ' + item.meaning)}">${escapeHtml(item.word)}</span>`;
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
    </div>
  </div>
  <div class="grid3">
    <div class="stat"><div class="n">${counts.new}</div><div class="l">New</div></div>
    <div class="stat"><div class="n">${counts.genin}</div><div class="l">Genin</div></div>
    <div class="stat"><div class="n">${counts.chunin}</div><div class="l">Chunin</div></div>
    <div class="stat"><div class="n">${counts.jonin}</div><div class="l">Jonin</div></div>
    <div class="stat"><div class="n">${counts.anbu}</div><div class="l">Anbu</div></div>
    <div class="stat"><div class="n">${counts.kage}</div><div class="l">Kage</div></div>
  </div>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="resetProgress()">Reset all progress</button>
  </div>
  `;
}

function renderInfo(){
  const learnableCount = learnableWords().length;
  return `
  <p class="footer-note" style="text-align:left;">
    Kaishi 1.5k deck — ${learnableCount} of ${VOCAB.length} words have mnemonics and are ready to learn.<br><br>
    SRS intervals follow WaniKani's timing: 4h → 8h → 1d → 2d → 1wk → 2wk → 1mo → 4mo → Kage.<br><br>
    ${storageOk ? '<span class="savebadge"><span class="dot"></span>Progress saves automatically</span>' : '<span class="savebadge"><span class="dot off"></span>Storage unavailable — progress will not persist this session</span>'}
  </p>
  <div style="text-align:center;margin-top:16px;">
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

// Shows what each kanji in the word is built from. Recognition aid only —
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
  `;
}

function renderLessonQuiz(){
  const {quizQueue} = lessonState;
  if(quizQueue.length===0){
    const batchLen = lessonState.batch.length;
    lessonState = null;
    return `${nav('lessons')}<div class="empty">Lesson batch complete — ${batchLen} word${batchLen===1?'':'s'} added to reviews.<br>First review in 4 hours.</div>`;
  }
  const q = quizQueue[0];
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
    <input type="text" id="quizInput" placeholder="Type the ${label.toLowerCase()}" autocomplete="off">
    <button class="primary" onclick="submitQuizAnswer()">Check</button>
  ` : `
    <div class="field result-${lessonState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${lessonState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(lessonState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(lessonState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(q.type==='meaning'?item.meaning:item.reading)}</div>` : ''}
      ${!lessonState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(lessonState)?'margin-top:6px;':''}">You typed: ${escapeHtml(lessonState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${answerVisible(lessonState) ? `
      <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>
    ` : `
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
        <b>Shuffled</b> — random order.<br>
        <b>Genin First</b> — review Genin-stage items first, then randomize the rest. Best when you're short on time.<br>
        <b>Lower Stages First</b> — always review whichever due item is least-learned, Genin → Chunin → Jonin → Anbu.
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
      <div class="settings-desc">Using <b>${escapeHtml(jaVoice.name)}</b>. Audio is spoken by your device, so it only appears after you've answered — never on the question itself.</div>
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

function renderAccountCard(){
  // sync.js is optional; degrade to a plain note rather than offering a button
  // that would throw.
  if(typeof signInWithEmail !== 'function'){
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title">Sync</div>
      <div class="settings-desc">Sync is unavailable right now — progress is being saved to this device only.</div>
    </div>`;
  }
  const notice = typeof syncNotice === 'string' && syncNotice
    ? `<p class="forecast" style="text-align:center;margin-top:12px;">${escapeHtml(syncNotice)}</p>` : '';
  const signedIn = typeof syncUser !== 'undefined' && syncUser;
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
        <div class="settings-desc">Sign in to keep progress in step across devices. We'll email you a link — no password to remember. Without this, progress stays in this browser only.</div>
        <input type="email" id="syncEmailInput" placeholder="you@example.com" autocomplete="email">
      </div>
      <button class="primary" onclick="signInWithEmail()">Email me a sign-in link</button>
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
    return `${nav('review')}<div class="empty">Review session complete — ${total} item${total===1?'':'s'} reviewed.<br>${clean} of ${total} answered correctly first time.</div>`;
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
  // Only preview the stage change on the question that completes the item —
  // before that nothing is committed, so promising a change would be a lie.
  const completesItem = reviewState.showAnswer && reviewState.lastCorrect &&
    (q.type==='meaning' ? res.reading : res.meaning);
  const newStagePreview = completesItem ? computeReviewStage(p.stage, !res.missed) : null;
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
    <input type="text" id="reviewInput" placeholder="Type the ${label.toLowerCase()}" autocomplete="off">
    <button class="primary" onclick="submitReviewAnswer()">Check</button>
  ` : `
    <div class="field result-${reviewState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${reviewState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(reviewState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(reviewState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(answer)}</div>` : ''}
      ${!reviewState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(reviewState)?'margin-top:6px;':''}">You typed: ${escapeHtml(reviewState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${settings.showSrsIndicator && completesItem ? `<p class="forecast" style="text-align:center;">${STAGE_NAMES[p.stage]} → ${STAGE_NAMES[newStagePreview]}</p>` : ''}
    ${answerVisible(reviewState) ? `
      <div class="field"><div class="k">Example${audioBtn('speakSentence', item.id, 'Play sentence')}</div><div class="v jp">${escapeHtml(item.sentence)}</div><div class="v" style="font-size:13px;color:var(--text-dim);margin-top:4px;">${escapeHtml(item.sentence_meaning)}</div></div>
      <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>
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
    return `<div class="empty">Extra study complete — ${done} word${done===1?'':'s'} practiced.<br>This doesn't change their SRS timing, just extra reps.</div><div style="text-align:center;margin-top:10px;"><button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button></div>`;
  }
  const q = extraStudyState.queue[extraStudyState.index];
  const item = VOCAB.find(v=>v.id===q.id);
  const label = q.type==='meaning' ? 'Meaning' : 'Reading';
  const qClass = q.type==='meaning' ? 'q-meaning' : 'q-reading';
  const answer = q.type==='meaning' ? item.meaning : item.reading;
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
    <input type="text" id="extraInput" placeholder="Type the ${label.toLowerCase()}" autocomplete="off">
    <button class="primary" onclick="submitExtraStudyAnswer()">Check</button>
  ` : `
    <div class="field result-${extraStudyState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${extraStudyState.lastCorrect ? 'Correct' : 'Incorrect'} · ${label}${answerVisible(extraStudyState)?audioBtn('speakWord', item.id, 'Play word'):''}</div>
      ${answerVisible(extraStudyState) ? `<div class="v ${q.type==='reading'?'jp':''}">${escapeHtml(answer)}</div>` : ''}
      ${!extraStudyState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);${answerVisible(extraStudyState)?'margin-top:6px;':''}">You typed: ${escapeHtml(extraStudyState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${answerVisible(extraStudyState) ? `
      <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${escapeHtml(item.mnemonic)}</div></div>
    ` : `
      <button class="secondary" onclick="revealExtraStudyAnswer()">Show answer</button>
    `}
    <button class="primary" onclick="advanceExtraStudy()">Next</button>
  `}
  `;
}

function render(){
  const root = document.getElementById('root');
  let body;
  if(view==='dashboard') body = renderDashboard();
  else if(view==='lessons') body = renderLessons();
  else if(view==='settings') body = renderSettings();
  else if(view==='info') body = renderInfo();
  else if(view==='extrastudy') body = renderExtraStudy();
  else body = renderReview();
  root.innerHTML = `
    <header>
      <h1>Kaishi SRS</h1>
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
// #quizInput — otherwise wanakana swallows Enter (and clears the field)
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
  loadReviewHistory();
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
  render();
  // Sync is best-effort and must never block the app from being usable.
  if(typeof initSync === 'function'){
    initSync().catch(()=>{});
  }
}

init();
