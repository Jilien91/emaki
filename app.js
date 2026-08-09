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
  showSrsIndicator: true
};
const MISTAKE_WINDOW_MS = 24*3600*1000;
const STAGE_NAMES = ['New','Genin 1','Genin 2','Genin 3','Genin 4','Chunin 1','Chunin 2','Jonin','Anbu','Kage'];
const INTERVAL_HOURS = [null,4,8,23,47,168,336,720,2880,null];
const TIER_COLOR = s => s===0?'new':s<=4?'genin':s<=6?'chunin':s===7?'jonin':s===8?'anbu':'kage';

let VOCAB = [];
let progress = {};
let settings = { ...DEFAULT_SETTINGS };
let dailyLessons = { date: null, count: 0 };
let mistakes = []; // [{id, timestamp}]
let activityDates = []; // ['YYYY-MM-DD', ...]
let reviewHistory = {}; // {'YYYY-MM-DD': count}
let storageOk = true;
let view = 'dashboard';
let currentReviewId = null;
let showAnswer = false;
let sessionCorrect = 0;
let sessionTotal = 0;
let lessonState = null; // {batch, phase:'study'|'quiz', studyIndex, showAnswer, quizQueue, quizProgress, lastCorrect, lastInput}
let reviewGrade = null;
let reviewLastInput = '';
let extraStudyState = null; // {queue:[ids], index, showAnswer, lastCorrect, lastInput}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
  // Split the typed answer the same way we split the stored meaning, so
  // "like, fond of" is checked as ["like","fond of"] against each accepted
  // candidate rather than as one literal blob that matches nothing.
  const inputCandidates = userInput.trim().toLowerCase().split(/[,/]/).map(s=>s.trim()).filter(Boolean);
  if(inputCandidates.length===0) return false;
  const correctCandidates = meaningCandidates(meaning);
  return inputCandidates.some(input => correctCandidates.some(c => fuzzyMatch(input, c)));
}

function checkReading(userInput, reading){
  const raw = userInput.trim();
  const input = window.wanakana ? window.wanakana.toHiragana(raw) : raw;
  return reading.split('・').map(s=>s.trim()).includes(input);
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
}

function loadSettings(){
  try{
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if(raw){ settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)); }
  }catch(e){}
}

function saveSettings(){
  try{ window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
}

function dateKey(d){
  d = d || new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function todayKey(){ return dateKey(); }

function loadDailyLessons(){
  try{
    const raw = window.localStorage.getItem(DAILY_KEY);
    if(raw){ dailyLessons = JSON.parse(raw); }
  }catch(e){}
  if(dailyLessons.date !== todayKey()){ dailyLessons = { date: todayKey(), count: 0 }; }
}

function saveDailyLessons(){
  try{ window.localStorage.setItem(DAILY_KEY, JSON.stringify(dailyLessons)); }catch(e){}
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
}

function pruneMistakes(){
  const cutoff = now() - MISTAKE_WINDOW_MS;
  mistakes = mistakes.filter(m=>m.timestamp>=cutoff);
}

function recordMistake(id){
  mistakes.push({id, timestamp: now()});
  saveMistakes();
}

// Unique word ids with a mistake in the last 24h, most-recently-missed first.
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
  if(!set.has(dateKey(d))){ d = new Date(d.getTime() - 86400000); }
  let streak = 0;
  while(set.has(dateKey(d))){
    streak++;
    d = new Date(d.getTime() - 86400000);
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
}

function nextStudyItem(){
  lessonState.studyIndex++;
  render();
}

function prevStudyItem(){
  if(lessonState.studyIndex>0){ lessonState.studyIndex--; render(); }
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
  render();
}

function submitQuizAnswer(){
  const q = lessonState.quizQueue[0];
  const item = VOCAB.find(v=>v.id===q.id);
  const input = document.getElementById('quizInput');
  const value = input ? input.value : '';
  const correct = q.type==='meaning' ? checkMeaning(value, item.meaning) : checkReading(value, item.reading);
  lessonState.showAnswer = true;
  lessonState.lastCorrect = correct;
  lessonState.lastInput = value;
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
  settings.showSrsIndicator = indicatorEl.value === 'yes';
  settings.reviewOrder = orderEl.value;
  saveSettings();
  switchView('dashboard');
}

function computeReviewStage(stage, correct){
  if(correct) return Math.min(9, stage+1);
  return stage<=4 ? Math.max(1,stage-1) : Math.max(1,stage-2);
}

// Picks which due item to review next, per the review-ordering setting.
function pickNextReview(due){
  if(settings.reviewOrder === 'genin-first'){
    const genin = due.filter(v => TIER_COLOR(getEntry(v.id).stage) === 'genin');
    const pool = genin.length > 0 ? genin : due;
    return pool[Math.floor(Math.random()*pool.length)].id;
  }
  if(settings.reviewOrder === 'lower-stage-first'){
    let minStage = Infinity;
    let candidates = [];
    due.forEach(v=>{
      const s = getEntry(v.id).stage;
      if(s < minStage){ minStage = s; candidates = [v]; }
      else if(s === minStage){ candidates.push(v); }
    });
    return candidates[Math.floor(Math.random()*candidates.length)].id;
  }
  return due[Math.floor(Math.random()*due.length)].id; // shuffled
}

function answerReview(id, correct){
  const p = getEntry(id);
  const newStage = computeReviewStage(p.stage, correct);
  const nextReview = newStage===9 ? null : now() + INTERVAL_HOURS[newStage]*3600*1000;
  progress[id] = { stage:newStage, nextReview };
  sessionTotal++;
  if(correct) sessionCorrect++;
  else recordMistake(id);
  saveProgress();
  recordActivityToday();
  recordReviewCompleted();
  currentReviewId = null;
  showAnswer = false;
  reviewGrade = null;
  render();
}

function submitReviewAnswer(){
  const item = VOCAB.find(v=>v.id===currentReviewId);
  const input = document.getElementById('reviewInput');
  const value = input ? input.value : '';
  reviewGrade = checkMeaning(value, item.meaning);
  reviewLastInput = value;
  showAnswer = true;
  render();
}

function startExtraStudy(){
  const ids = recentMistakeIds();
  if(ids.length===0) return;
  extraStudyState = { queue: shuffle(ids.slice()), index:0, showAnswer:false };
  view = 'extrastudy';
  render();
}

function submitExtraStudyAnswer(){
  const id = extraStudyState.queue[extraStudyState.index];
  const item = VOCAB.find(v=>v.id===id);
  const input = document.getElementById('extraInput');
  const value = input ? input.value : '';
  extraStudyState.lastCorrect = checkMeaning(value, item.meaning);
  extraStudyState.lastInput = value;
  extraStudyState.showAnswer = true;
  render();
}

function advanceExtraStudy(){
  extraStudyState.index++;
  extraStudyState.showAnswer = false;
  render();
}

function switchView(v){ view=v; currentReviewId=null; showAnswer=false; reviewGrade=null; extraStudyState=null; render(); }

function resetProgress(){
  if(!confirm('Reset all progress? This clears every SRS level and cannot be undone.')) return;
  progress = {};
  sessionCorrect=0; sessionTotal=0;
  saveProgress();
  render();
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

  const mistakeIds = recentMistakeIds();
  const mistakeItems = mistakeIds.map(id=>VOCAB.find(v=>v.id===id)).filter(Boolean);

  const todayCount = reviewsCompletedOn();
  const yesterday = new Date(now() - 86400000);
  const yesterdayCount = reviewsCompletedOn(yesterday);

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
      ${mistakeItems.map(item=>`<div class="wordrow"><span class="w jp">${item.word}</span><span class="m">${escapeHtml(item.meaning)}</span></div>`).join('')}
      <button class="primary" style="margin-top:10px;" onclick="startExtraStudy()">Extra Study (${mistakeItems.length})</button>
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

function renderLessonStudy(){
  const {batch, studyIndex} = lessonState;
  const item = VOCAB.find(v=>v.id===batch[studyIndex]);
  const isLast = studyIndex === batch.length-1;
  return `
  ${nav('lessons')}
  <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;text-align:center;">Lesson ${studyIndex+1} of ${batch.length}</div>
  <div class="bigword" style="background:var(--genin-bg);color:var(--genin);">
    ${item.word}
    <div class="jp" style="font-size:20px;color:var(--text-dim);margin-top:10px;">${item.reading}</div>
  </div>
  <div class="field"><div class="k">Meaning</div><div class="v">${item.meaning}</div></div>
  <div class="field"><div class="k">Mnemonic</div><div class="v mnem">${item.mnemonic}</div></div>
  ${item.notes ? `<div class="field" style="background:var(--kage-bg);"><div class="k" style="color:var(--kage);">Usage note</div><div class="v" style="font-size:13px;">${item.notes}</div></div>` : ''}
  <div class="field"><div class="k">Example</div><div class="v jp" style="margin-bottom:4px;">${item.sentence}</div><div class="v" style="font-size:13px;color:var(--text-dim);">${item.sentence_meaning}</div></div>
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
  return `
  ${nav('lessons')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <span style="font-size:12px;color:var(--text-dim);">Quiz · ${quizQueue.length} left</span>
    <span class="pill" style="background:var(--genin-bg);color:var(--genin);">${label}</span>
  </div>
  <div class="bigword" style="background:var(--surface-2);">${item.word}</div>
  <div class="field"><div class="k">Example</div><div class="v jp">${item.sentence}</div></div>
  ${!lessonState.showAnswer ? `
    <input type="text" id="quizInput" placeholder="Type the ${label.toLowerCase()}" autocomplete="off">
    <button class="primary" onclick="submitQuizAnswer()">Check</button>
  ` : `
    <div class="field result-${lessonState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${lessonState.lastCorrect ? 'Correct' : 'Incorrect'}</div>
      <div class="v ${q.type==='reading'?'jp':''}">${q.type==='meaning'?item.meaning:item.reading}</div>
      ${!lessonState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);margin-top:6px;">You typed: ${escapeHtml(lessonState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${item.mnemonic}</div></div>
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
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button>
  </div>
  `;
}

function renderReview(){
  const due = dueReviews();
  if(due.length===0){
    const upcoming = nextUpcoming();
    return `${nav('review')}<div class="empty">No reviews due right now.${upcoming?`<br>Next batch unlocks in ${humanizeDuration(upcoming-now())}.`:'<br>Complete a lesson first.'}</div>`;
  }
  if(currentReviewId===null){
    currentReviewId = pickNextReview(due);
    showAnswer = false;
  }
  const item = VOCAB.find(v=>v.id===currentReviewId);
  const p = getEntry(item.id);
  const newStagePreview = showAnswer ? computeReviewStage(p.stage, reviewGrade) : null;
  return `
  ${nav('review')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <span style="font-size:12px;color:var(--text-dim);">Session ${sessionCorrect}/${sessionTotal}</span>
    <span class="pill" style="background:var(--${TIER_COLOR(p.stage)}-bg,var(--surface-2));color:var(--${TIER_COLOR(p.stage)});">${STAGE_NAMES[p.stage]}</span>
  </div>
  <div class="bigword" style="background:var(--surface-2);">${item.word}</div>
  <div class="field"><div class="k">Example</div><div class="v jp">${item.sentence}</div></div>
  ${!showAnswer ? `
    <input type="text" id="reviewInput" placeholder="Type the meaning" autocomplete="off">
    <button class="primary" onclick="submitReviewAnswer()">Check</button>
  ` : `
    <div class="field"><div class="k">Reading</div><div class="v jp">${item.reading}</div></div>
    <div class="field result-${reviewGrade?'correct':'incorrect'}">
      <div class="k">${reviewGrade ? 'Correct' : 'Incorrect'}</div>
      <div class="v">${item.meaning}</div>
      ${!reviewGrade ? `<div class="v" style="font-size:12px;color:var(--text-faint);margin-top:6px;">You typed: ${escapeHtml(reviewLastInput) || '(nothing)'}</div>` : ''}
    </div>
    ${settings.showSrsIndicator ? `<p class="forecast" style="text-align:center;">${STAGE_NAMES[p.stage]} → ${STAGE_NAMES[newStagePreview]}</p>` : ''}
    <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${item.mnemonic}</div></div>
    <button class="primary" onclick="answerReview(${item.id}, ${reviewGrade})">Next</button>
  `}
  `;
}

function renderExtraStudy(){
  if(!extraStudyState || extraStudyState.index >= extraStudyState.queue.length){
    const done = extraStudyState ? extraStudyState.queue.length : 0;
    extraStudyState = null;
    return `<div class="empty">Extra study complete — ${done} word${done===1?'':'s'} practiced.<br>This doesn't change their SRS timing, just extra reps.</div><div style="text-align:center;margin-top:10px;"><button class="reset-link" onclick="switchView('dashboard')">Back to dashboard</button></div>`;
  }
  const item = VOCAB.find(v=>v.id===extraStudyState.queue[extraStudyState.index]);
  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <span style="font-size:12px;color:var(--text-dim);">Extra Study · ${extraStudyState.index+1} of ${extraStudyState.queue.length}</span>
    <button class="reset-link" onclick="switchView('dashboard')">End session</button>
  </div>
  <div class="bigword" style="background:var(--surface-2);">${item.word}</div>
  <div class="field"><div class="k">Example</div><div class="v jp">${item.sentence}</div></div>
  ${!extraStudyState.showAnswer ? `
    <input type="text" id="extraInput" placeholder="Type the meaning" autocomplete="off">
    <button class="primary" onclick="submitExtraStudyAnswer()">Check</button>
  ` : `
    <div class="field result-${extraStudyState.lastCorrect?'correct':'incorrect'}">
      <div class="k">${extraStudyState.lastCorrect ? 'Correct' : 'Incorrect'}</div>
      <div class="v">${item.meaning}</div>
      ${!extraStudyState.lastCorrect ? `<div class="v" style="font-size:12px;color:var(--text-faint);margin-top:6px;">You typed: ${escapeHtml(extraStudyState.lastInput) || '(nothing)'}</div>` : ''}
    </div>
    <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${item.mnemonic}</div></div>
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
  const reviewInput = document.getElementById('reviewInput');
  const quizInput = document.getElementById('quizInput');
  const extraInput = document.getElementById('extraInput');
  const input = reviewInput || quizInput || extraInput;
  if(input) input.focus();
  if(quizInput && lessonState && lessonState.phase==='quiz' && lessonState.quizQueue.length>0){
    const currentQ = lessonState.quizQueue[0];
    if(currentQ.type==='reading' && window.wanakana){
      window.wanakana.bind(quizInput, { IMEMode: true });
    }
  }
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
  }else if(view==='review' && currentReviewId!==null){
    if(!showAnswer && document.getElementById('reviewInput')){
      e.preventDefault();
      e.stopPropagation();
      submitReviewAnswer();
    }else if(showAnswer){
      e.preventDefault();
      answerReview(currentReviewId, reviewGrade);
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
  try{
    const res = await fetch('data/vocab.json');
    VOCAB = await res.json();
  }catch(e){
    document.getElementById('root').innerHTML = '<div class="empty">Failed to load vocab data. Make sure data/vocab.json is reachable (serve this over http, not file://).</div>';
    return;
  }
  render();
}

init();
