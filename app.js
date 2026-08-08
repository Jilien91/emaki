const STORAGE_KEY = 'kaishi-progress';
const SETTINGS_KEY = 'kaishi-settings';
const DAILY_KEY = 'kaishi-daily-lessons';
const DEFAULT_SETTINGS = { dailyNewLimit: 20 };
const LESSON_BATCH_SIZE = 5;
const STAGE_NAMES = ['New','Apprentice 1','Apprentice 2','Apprentice 3','Apprentice 4','Guru 1','Guru 2','Master','Enlightened','Burned'];
const INTERVAL_HOURS = [null,4,8,23,47,168,336,720,2880,null];
const TIER_COLOR = s => s===0?'new':s<=4?'apprentice':s<=6?'guru':s===7?'master':s===8?'enlightened':'burned';

let VOCAB = [];
let progress = {};
let settings = { ...DEFAULT_SETTINGS };
let dailyLessons = { date: null, count: 0 };
let storageOk = true;
let view = 'dashboard';
let currentReviewId = null;
let showAnswer = false;
let sessionCorrect = 0;
let sessionTotal = 0;
let lessonState = null; // {batch, phase:'study'|'quiz', studyIndex, showAnswer, quizQueue, quizProgress, lastCorrect, lastInput}
let reviewGrade = null;
let reviewLastInput = '';

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
  const input = userInput.trim().toLowerCase();
  if(!input) return false;
  return meaningCandidates(meaning).some(c => fuzzyMatch(input, c));
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

function todayKey(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
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
}

function incrementDailyLessons(){
  if(dailyLessons.date !== todayKey()){ dailyLessons = { date: todayKey(), count: 0 }; }
  dailyLessons.count++;
  saveDailyLessons();
}

function remainingToday(){
  return Math.max(0, settings.dailyNewLimit - dailyLessons.count);
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
  const batchSize = Math.min(LESSON_BATCH_SIZE, pending.length, remainingToday());
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

function saveDailyLimit(){
  const el = document.getElementById('dailyLimitInput');
  let val = parseInt(el.value, 10);
  if(isNaN(val)) val = DEFAULT_SETTINGS.dailyNewLimit;
  val = Math.min(100, Math.max(1, val));
  settings.dailyNewLimit = val;
  saveSettings();
  switchView('dashboard');
}

function answerReview(id, correct){
  const p = getEntry(id);
  let newStage;
  if(correct){
    newStage = Math.min(9, p.stage+1);
  }else{
    newStage = p.stage<=4 ? Math.max(1,p.stage-1) : Math.max(1,p.stage-2);
  }
  const nextReview = newStage===9 ? null : now() + INTERVAL_HOURS[newStage]*3600*1000;
  progress[id] = { stage:newStage, nextReview };
  sessionTotal++;
  if(correct) sessionCorrect++;
  saveProgress();
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

function switchView(v){ view=v; currentReviewId=null; showAnswer=false; reviewGrade=null; render(); }

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
  const counts = {new:0,apprentice:0,guru:0,master:0,enlightened:0,burned:0};
  VOCAB.forEach(v=>{
    const p = getEntry(v.id);
    counts[TIER_COLOR(p.stage)]++;
  });
  const due = dueReviews().length;
  const upcoming = nextUpcoming();
  let forecast = '';
  if(due===0 && upcoming){
    forecast = `<p class="forecast">Next review batch unlocks in ${humanizeDuration(upcoming-now())}</p>`;
  }
  const learnableCount = learnableWords().length;
  return `
  ${nav('dashboard')}
  <div class="grid3">
    <div class="stat"><div class="n">${counts.new}</div><div class="l">New</div></div>
    <div class="stat"><div class="n">${counts.apprentice}</div><div class="l">Apprentice</div></div>
    <div class="stat"><div class="n">${counts.guru}</div><div class="l">Guru</div></div>
    <div class="stat"><div class="n">${counts.master}</div><div class="l">Master</div></div>
    <div class="stat"><div class="n">${counts.enlightened}</div><div class="l">Enlightened</div></div>
    <div class="stat"><div class="n">${counts.burned}</div><div class="l">Burned</div></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">
      <span style="font-size:13px;color:var(--text-dim);">Reviews due right now</span>
      <span style="font-size:20px;font-weight:600;font-family:'Spectral',serif;">${due}</span>
    </div>
    ${forecast}
  </div>
  <p class="footer-note">
    Kaishi 1.5k deck — ${learnableCount} of ${VOCAB.length} words have mnemonics and are ready to learn.<br>
    SRS intervals follow WaniKani's timing: 4h → 8h → 1d → 2d → 1wk → 2wk → 1mo → 4mo → burned.<br>
    ${storageOk ? '<span class="savebadge" style="justify-content:center;"><span class="dot"></span>Progress saves automatically</span>' : '<span class="savebadge" style="justify-content:center;"><span class="dot off"></span>Storage unavailable — progress will not persist this session</span>'}
  </p>
  <div style="text-align:center;margin-top:10px;">
    <button class="reset-link" onclick="resetProgress()">Reset all progress</button>
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
  const batchSize = Math.min(LESSON_BATCH_SIZE, pending.length, remaining);
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
  <div class="bigword" style="background:var(--apprentice-bg);color:var(--apprentice);">
    ${item.word}
    <div class="jp" style="font-size:20px;color:var(--text-dim);margin-top:10px;">${item.reading}</div>
  </div>
  <div class="field"><div class="k">Meaning</div><div class="v">${item.meaning}</div></div>
  <div class="field"><div class="k">Mnemonic</div><div class="v mnem">${item.mnemonic}</div></div>
  ${item.notes ? `<div class="field" style="background:var(--burned-bg);"><div class="k" style="color:var(--burned);">Usage note</div><div class="v" style="font-size:13px;">${item.notes}</div></div>` : ''}
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
    <span class="pill" style="background:var(--apprentice-bg);color:var(--apprentice);">${label}</span>
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
  return `
  <div class="card" style="margin-bottom:16px;">
    <div class="field" style="margin-bottom:0;">
      <div class="k">New lessons per day</div>
      <input type="number" id="dailyLimitInput" min="1" max="100" value="${settings.dailyNewLimit}">
    </div>
  </div>
  <button class="primary" onclick="saveDailyLimit()">Save</button>
  <p class="forecast" style="text-align:center;margin-top:14px;">You've started ${dailyLessons.count} of ${settings.dailyNewLimit} new lessons today.</p>
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
    currentReviewId = due[Math.floor(Math.random()*due.length)].id;
    showAnswer = false;
  }
  const item = VOCAB.find(v=>v.id===currentReviewId);
  const p = getEntry(item.id);
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
    <div class="field"><div class="k">Mnemonic</div><div class="v mnem" style="font-size:13px;color:var(--text-dim);">${item.mnemonic}</div></div>
    <button class="primary" onclick="answerReview(${item.id}, ${reviewGrade})">Next</button>
  `}
  `;
}

function render(){
  const root = document.getElementById('root');
  let body;
  if(view==='dashboard') body = renderDashboard();
  else if(view==='lessons') body = renderLessons();
  else if(view==='settings') body = renderSettings();
  else body = renderReview();
  root.innerHTML = `
    <header>
      <h1>Kaishi SRS</h1>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="sub">1500-word deck</span>
        <button class="gear-btn" onclick="switchView('settings')" title="Settings" aria-label="Settings">⚙</button>
      </div>
    </header>
    ${body}
  `;
  const reviewInput = document.getElementById('reviewInput');
  const quizInput = document.getElementById('quizInput');
  const input = reviewInput || quizInput;
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
  }
}, true);

async function init(){
  loadProgress();
  loadSettings();
  loadDailyLessons();
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
