// Drives the real study history code out of app.js.
//
//   node scripts/history-test.js
//
// The history map is the week strip's record kept for longer, so the thing it
// most needs to get right is agreeing with the strip. A map that called a day
// missed while the strip showed it covered by a kunai would be telling the
// user two different stories about the streak they care most about. The last
// case renders both and compares them.
//
// Functions are lifted out of app.js by name, as in streak-test.js, against a
// clock fixed at Monday 14 September 2026.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const WANTED = ['dateKey', 'addDays', 'weekStart', 'streakDayState', 'historyDate',
                'historyWeeks', 'historyDayLabel', 'historyDetail', 'longestStreak',
                'headbandSvg', 'renderStreakWeek'];

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
function extractDecl(prefix){
  const start = APP.indexOf('\n' + prefix);
  if(start < 0) throw new Error('app.js has no top-level ' + prefix);
  return APP.slice(start + 1, APP.indexOf(';', start) + 1);
}
const SOURCE = [extractDecl('const WEEKDAYS'), extractDecl('const HISTORY_MONTHS')]
  .concat(WANTED.map(extract)).join('\n\n');

const TODAY = '2026-09-14';
function world(state, today){
  const [Y, M, D] = (today || TODAY).split('-').map(Number);
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a){ if(a.length) super(...a); else super(Y, M - 1, D, 12, 0, 0); }
    static now(){ return new FakeDate().getTime(); }
  }
  const ctx = {
    Date: FakeDate,
    activityDates: state.activity || [],
    streakSaves: { count: 1, lastEarned: TODAY, savedDates: state.saved || [] },
    reviewHistory: state.reviews || {},
    historyMode: state.mode || 'daily',
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

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

// ---- What a day was ---------------------------------------------------------
{
  const w = world({});
  const studied = new Set(['2026-09-10', '2026-09-11']);
  const saved = new Set(['2026-09-11', '2026-09-12']);
  const s = k => w.streakDayState(k, TODAY, studied, saved, '2026-09-01');
  check('studied beats a kunai on the same day', s('2026-09-11'), 'studied');
  check('a kunai day', s('2026-09-12'), 'saved');
  check('today with nothing yet is pending, not missed', s(TODAY), 'pending');
  check('tomorrow is still to come', s('2026-09-15'), 'future');
  check('before the first study is untracked, not missed', s('2026-08-31'), 'untracked');
  check('a gap after starting is missed', s('2026-09-05'), 'missed');
}

// ---- Longest streak ---------------------------------------------------------
check('a kunai joins two runs into one',
  world({ activity: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05', '2026-09-06'],
          saved: ['2026-09-04'] }).longestStreak(), 6);
check('without it they are two runs',
  world({ activity: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05', '2026-09-06'] }).longestStreak(), 3);
check('no study, no streak', world({}).longestStreak(), 0);
check('across the end of a month', world({ activity: ['2026-08-31', '2026-09-01'] }).longestStreak(), 2);
check('across the clocks going back', world({ activity: ['2026-10-24', '2026-10-25', '2026-10-26'] }).longestStreak(), 3);
check('out of order and repeated, as a sync union can leave it',
  world({ activity: ['2026-09-02', '2026-09-01', '2026-09-02'], saved: ['2026-09-01'] }).longestStreak(), 2);

// ---- The weeks the map draws ------------------------------------------------
{
  const w = world({ activity: ['2026-09-10'], reviews: { '2026-09-10': 54 } });
  const weeks = w.historyWeeks(new w.Date());
  const last = weeks[weeks.length - 1];
  check('a year of weeks when study began recently', weeks.length, 53);
  check('seven days in every week', weeks.every(x => x.length === 7), true);
  check('every week starts on a Monday', weeks.every(x => w.historyDate(x[0].key).getDay() === 1), true);
  check('the last week is this one', last.map(d => d.key)[0], TODAY);
  check('the rest of this week is still to come', last.slice(1).every(d => d.state === 'future'), true);
  check('a day carries its review count', weeks.flat().find(d => d.key === '2026-09-10').reviews, 54);
}
{
  const w = world({ activity: ['2024-09-10', '2026-09-10'] });
  const weeks = w.historyWeeks(new w.Date());
  check('study from two years ago is kept, not cut off at a year',
    weeks[0][0].key <= '2024-09-10' && weeks[0][6].key >= '2024-09-10', true);
}

// ---- The line under the map -------------------------------------------------
{
  const state = {
    activity: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-12', '2026-09-13'],
    saved: ['2026-09-11'],
    reviews: { '2026-09-10': 54 },
  };
  const w = world(state);
  const weeks = w.historyWeeks(new w.Date());
  check('a studied day', w.historyDetail(weeks, '2026-09-10'), 'Thu 10 Sep 2026 · Studied · 54 reviews');
  check('a kunai day', w.historyDetail(weeks, '2026-09-11'), 'Fri 11 Sep 2026 · Covered by a kunai');
  check('today, not yet studied', w.historyDetail(weeks, TODAY), 'Mon 14 Sep 2026 · Not studied yet');

  const wk = world(Object.assign({ mode: 'weekly' }, state));
  const wweeks = wk.historyWeeks(new wk.Date());
  check('a full week', wk.historyDetail(wweeks, '2026-09-09'),
    '7 – 13 Sep 2026 · 6 of 7 days studied · 1 kunai · 54 reviews');
  check('this week, one day in', wk.historyDetail(wweeks, TODAY),
    '14 – 20 Sep 2026 · 0 of 1 day studied so far · 0 reviews');
  check('a week before anything', wk.historyDetail(wweeks, '2026-08-05'), '3 – 9 Aug 2026 · Before you started');
  check('a week across two months, all of it before the first study', wk.historyDetail(wweeks, '2026-09-01'),
    '31 Aug – 6 Sep 2026 · Before you started');
}

// ---- The strip and the map agree --------------------------------------------
{
  // A Friday, so the week has every state in it but untracked.
  const w = world({ activity: ['2026-09-10', '2026-09-14', '2026-09-16'], saved: ['2026-09-15'] }, '2026-09-18');
  const strip = [...w.renderStreakWeek().matchAll(/hb-day hb-day-(\w+)/g)].map(m => m[1]);
  const weeks = w.historyWeeks(new w.Date());
  check('the strip draws what it should',
    strip, ['studied', 'saved', 'studied', 'missed', 'pending', 'future', 'future']);
  check('and this week on the map says the same', weeks[weeks.length - 1].map(d => d.state), strip);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
