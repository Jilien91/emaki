// Checks the merge rules in sync.js against the cases that have actually gone
// wrong, because a sync bug does not announce itself: it looks like a normal
// day until a day of work is missing, and by then the evidence is overwritten.
//
//   node scripts/sync-merge-test.js
//
// Node rather than Perl, and the only JavaScript here that is not the app,
// because the thing under test is JavaScript and running the real file beats
// reimplementing its rules in another language and testing the reimplementation.
// It loads sync.js as it ships, into a scope holding just enough of a browser
// and of app.js for the merge functions to run. No dependencies, no build step.
//
// Written on 27 August 2026, after a morning of study was overwritten by a
// laptop that had marked itself dirty rolling the day over and pushed its copy
// of yesterday over the top. The first two cases are that incident, in both
// directions.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SYNC = path.join(__dirname, '..', 'sync.js');

// Everything sync.js reaches for that lives in app.js or the browser. The merge
// functions touch very little of it, which is itself worth knowing.
const stubs = `
  var store = {};
  var window = { localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k,v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  }};
  var document = { getElementById: () => null, addEventListener: () => {} };
  var supabase = undefined;
  var STREAK_SAVE_MAX = 1;
  var DEFAULT_SETTINGS = { dailyNewLimit: 20, theme: 'system', lessonBatchSize: 5 };
  var progress = {}, settings = {}, mistakes = [], activityDates = [],
      reviewHistory = {}, dailyLessons = {}, streakSaves = {},
      lessonState = null, reviewState = null;
  var TODAY = '2026-08-27';
  function todayKey(){ return TODAY; }
  function render(){}
  function saveProgress(){} function saveSettings(){} function saveMistakes(){}
  function saveActivity(){} function saveStreakSaves(){} function saveReviewHistory(){}
  function saveDailyLessons(){}
`;

const cases = `
(function(){
  const results = [];
  const snap = o => Object.assign({
    progress:{}, settings:{}, mistakes:[], activity_dates:[],
    review_history:{}, daily_lessons:{date:TODAY,count:0},
    streak_saves:{count:1,lastEarned:'2026-08-26',savedDates:[]}
  }, o);

  // The incident. This device is holding yesterday and has not read the server;
  // the server has today's lessons and reviews on it.
  const yesterday = snap({
    progress: { 1:{stage:2,nextReview:100,t:10}, 87:{stage:1,nextReview:200,t:20} },
    review_history: { '2026-08-26': 1 },
    activity_dates: ['2026-08-26']
  });
  const stale = snap({
    progress: { 1:{stage:2,nextReview:100,t:10}, 87:{stage:1,nextReview:200,t:20} },
    review_history: { '2026-08-26': 1 },
    activity_dates: ['2026-08-26']
  });
  const today = snap({
    progress: {
      1:{stage:3,nextReview:900,t:5000}, 87:{stage:1,nextReview:200,t:20},
      88:{stage:1,nextReview:950,t:5100}
    },
    review_history: { '2026-08-26': 1, '2026-08-27': 12 },
    activity_dates: ['2026-08-26','2026-08-27'],
    daily_lessons: { date: TODAY, count: 10 }
  });
  results.push(['the stale device does not roll the server back',
    mergeSnapshots(yesterday, stale, today), today]);
  results.push(['the good device keeps its day when the server is behind',
    mergeSnapshots(yesterday, today, stale), today]);

  // Both devices reviewed today since they last agreed. Each gain is kept; a
  // maximum would report ten when each device did ten.
  results.push(['concurrent review counts add up',
    mergeSnapshots(snap({review_history:{'2026-08-27':5}}),
                   snap({review_history:{'2026-08-27':15}}),
                   snap({review_history:{'2026-08-27':12}})).review_history,
    {'2026-08-27': 22}]);

  // Both moved the same card. The later decision wins.
  results.push(['the later decision on a card wins',
    mergeSnapshots(snap({progress:{5:{stage:4,nextReview:1,t:100}}}),
                   snap({progress:{5:{stage:5,nextReview:2,t:200}}}),
                   snap({progress:{5:{stage:1,nextReview:3,t:300}}})).progress[5],
    {stage:1,nextReview:3,t:300}]);

  // Neither is stamped, so the lower stage: a card the user has just forgotten
  // must not disappear for months on the strength of a guess.
  results.push(['unstamped entries fall back to the lower stage',
    mergeSnapshots(snap({progress:{5:{stage:4,nextReview:1}}}),
                   snap({progress:{5:{stage:5,nextReview:2}}}),
                   snap({progress:{5:{stage:1,nextReview:3}}})).progress[5],
    {stage:1,nextReview:3}]);

  // No base at all: the first sync on a device. Nothing may be lost.
  const m6 = mergeSnapshots(null,
    snap({ progress:{1:{stage:2,t:1}}, activity_dates:['2026-08-25'] }),
    snap({ progress:{2:{stage:3,t:2}}, activity_dates:['2026-08-26'] }));
  results.push(['no base keeps both sides',
    [Object.keys(m6.progress), m6.activity_dates],
    [['1','2'], ['2026-08-25','2026-08-26']]]);

  // A device that has not noticed the date turn over must not have its
  // yesterday counted into today.
  results.push(['a stale day of lessons is not counted into today',
    mergeSnapshots(snap({daily_lessons:{date:'2026-08-26', count:20}}),
                   snap({daily_lessons:{date:'2026-08-26', count:20}}),
                   snap({daily_lessons:{date:TODAY, count:4}})).daily_lessons,
    {date:TODAY, count:4}]);

  // One device spent the kunai and the other did not know.
  results.push(['a spent kunai stays spent',
    mergeSnapshots(snap({streak_saves:{count:1,lastEarned:'2026-08-20',savedDates:[]}}),
                   snap({streak_saves:{count:0,lastEarned:TODAY,savedDates:['2026-08-26']}}),
                   snap({streak_saves:{count:1,lastEarned:'2026-08-20',savedDates:[]}})).streak_saves,
    {count:0,lastEarned:TODAY,savedDates:['2026-08-26']}]);

  // Two devices cannot each grant the same one.
  results.push(['a kunai is not granted twice',
    mergeSnapshots(snap({streak_saves:{count:0,lastEarned:'2026-08-20',savedDates:[]}}),
                   snap({streak_saves:{count:1,lastEarned:TODAY,savedDates:[]}}),
                   snap({streak_saves:{count:1,lastEarned:TODAY,savedDates:[]}})).streak_saves.count,
    1]);

  // The theme changed here, the daily limit on the phone. Keep both.
  results.push(['settings merge field by field',
    mergeSnapshots(snap({settings:{theme:'dark', dailyNewLimit:20}}),
                   snap({settings:{theme:'light', dailyNewLimit:20}}),
                   snap({settings:{theme:'dark', dailyNewLimit:30}})).settings,
    {theme:'light', dailyNewLimit:30}]);

  results.push(['mistakes union without duplicates',
    mergeSnapshots(null,
      snap({mistakes:[{id:1,type:'meaning',timestamp:100},{id:2,type:'reading',timestamp:200}]}),
      snap({mistakes:[{id:2,type:'reading',timestamp:200},{id:3,type:'meaning',timestamp:300}]})
    ).mistakes.map(m=>m.id),
    [1,2,3]]);

  // A merge that changes nothing has to compare equal, or every sync writes.
  const same = snap({ progress:{1:{stage:2,t:1}} });
  results.push(['an unchanged merge is recognised as unchanged',
    sameData(mergeSnapshots(same, same, same), same), true]);

  // ---- The cases Codex found on 27 August 2026 ------------------------------

  // A half-answer is not a decision, so a device that answered one half must
  // not out-rank a device that finished the word. This is guarded here as well
  // as at its source, because the stamp is what the merge trusts: if anything
  // ever starts stamping half-answers again, this is where it should fail.
  // The local side here is what a half-answer leaves behind now: statistics
  // changed and the write stamp untouched, because only completing a lesson or
  // a review calls
  // touchEntry. That is what makes the completed review on the other device the
  // later decision. If anything ever stamps a half-answer again this stops
  // describing reality, which is the point of writing it down as data.
  results.push(['a later half-answer does not undo a completed review',
    mergeSnapshots(snap({progress:{5:{stage:3,t:100}}}),
                   snap({progress:{5:{stage:3,t:100,m:{c:1,w:0,s:1,b:1}}}}),
                   snap({progress:{5:{stage:4,t:200}}})).progress[5].stage,
    4]);

  // A base older than a state both sides already agree on. Nothing was gained
  // by anybody, so nothing may be added.
  const staleBase = snap({ review_history:{'2026-08-27':5}, daily_lessons:{date:TODAY,count:2} });
  const agreed    = snap({ review_history:{'2026-08-27':9}, daily_lessons:{date:TODAY,count:6} });
  results.push(['an old base does not inflate counts both sides already share',
    [mergeSnapshots(staleBase, agreed, agreed).review_history['2026-08-27'],
     mergeSnapshots(staleBase, agreed, agreed).daily_lessons.count],
    [9, 6]]);

  // One device banks the kunai, the other spends the same entitlement. It
  // cannot both have covered a day and still be in hand.
  results.push(['a kunai cannot be banked and spent at once',
    mergeSnapshots(snap({streak_saves:{count:0,lastEarned:'2026-08-20',savedDates:[]}}),
                   snap({streak_saves:{count:1,lastEarned:TODAY,savedDates:[]}}),
                   snap({streak_saves:{count:0,lastEarned:TODAY,savedDates:['2026-08-26']}})).streak_saves,
    {count:0, lastEarned:TODAY, savedDates:['2026-08-26']}]);

  // Two stale devices spend one kunai on two different days. Both dates are
  // real and are kept; the count must not go negative or wrap.
  results.push(['two spends from one kunai floor at zero rather than going negative',
    mergeSnapshots(snap({streak_saves:{count:1,lastEarned:'2026-08-20',savedDates:[]}}),
                   snap({streak_saves:{count:0,lastEarned:TODAY,savedDates:['2026-08-25']}}),
                   snap({streak_saves:{count:0,lastEarned:TODAY,savedDates:['2026-08-26']}})).streak_saves,
    {count:0, lastEarned:TODAY, savedDates:['2026-08-25','2026-08-26']}]);

  return results;
})()
`;

const results = vm.runInThisContext(
  stubs + '\n' + fs.readFileSync(SYNC, 'utf8') + '\n' + cases
);

let failed = 0;
for(const [name, actual, expected] of results){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if(!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if(!ok){
    console.log('         got      ' + a);
    console.log('         expected ' + e);
  }
}

console.log(failed === 0
  ? '\nall ' + results.length + ' merge cases pass'
  : '\n' + failed + ' of ' + results.length + ' FAILED');
process.exit(failed ? 1 : 0);
