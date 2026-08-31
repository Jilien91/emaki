// Drives the real kunai code out of app.js.
//
//   node scripts/streak-test.js
//
// The kunai is the one piece of state the user can lose that no amount of
// studying earns back within three days, so it is worth a test of its own. Two
// bugs have reached Lasz through it: one that spent his kunai on a gap twenty
// days behind the streak it was meant to rescue, and one on 31 August 2026
// where the laptop covered a day he had spent on the phone doing 54 reviews.
// Both were the code deciding a day was missed on evidence it did not have,
// which is what most of the cases below are about.
//
// The functions are lifted out of app.js by name rather than copied here, so a
// change to the real ones is a change to what is tested. Anything the slice
// fails to find is reported rather than quietly skipped.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const WANTED = ['dateKey', 'todayKey', 'addDays', 'daysSince',
                'replenishStreakSaves', 'refundUnneededSaves',
                'applyStreakSaves', 'refreshStreakSaves', 'studyStreak'];

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
const SOURCE = WANTED.map(extract).join('\n\n');

// ---- A world for them to run in ---------------------------------------------
function makeWorld(today, opts){
  opts = opts || {};
  const RealDate = Date;
  const parts = today.split('-').map(Number);
  class FakeDate extends RealDate {
    constructor(){
      const a = Array.prototype.slice.call(arguments);
      if(a.length === 0) super(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
      else if(a.length === 1) super(a[0]);
      else super(a[0], a[1], a[2] || 1, a[3] || 0, a[4] || 0, a[5] || 0);
    }
    static now(){ return new FakeDate().getTime(); }
  }
  const ctx = {
    Date: FakeDate, Set: Set, Math: Math, JSON: JSON,
    String: String, Number: Number, Array: Array, Object: Object,
    STREAK_SAVE_MAX: 1,
    STREAK_SAVE_DAYS: 3,
    activityDates: (opts.activity || []).slice(),
    streakSaves: JSON.parse(JSON.stringify(opts.saves ||
                  { count: 1, lastEarned: today, savedDates: [] })),
    writes: 0,
    remoteDataSettled: function(){ return opts.settled !== false; }
  };
  ctx.saveStreakSaves = function(){ ctx.writes++; };
  if(opts.noSyncLayer) delete ctx.remoteDataSettled;
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

const TODAY = '2026-08-31';
function state(w){
  return { count: w.streakSaves.count, saved: w.streakSaves.savedDates.slice() };
}

// ---- The ordinary days -------------------------------------------------------
{
  const w = makeWorld(TODAY, { activity: ['2026-08-28','2026-08-29','2026-08-30'] });
  w.refreshStreakSaves();
  check('studied yesterday: nothing is spent', state(w), { count: 1, saved: [] });
  check('studied yesterday: nothing is written', w.writes, 0);
  check('studied yesterday: the streak counts back', w.studyStreak(), 3);
}
{
  const w = makeWorld(TODAY, { activity: ['2026-08-27','2026-08-28','2026-08-29'] });
  w.refreshStreakSaves();
  check('one missed day is covered', state(w), { count: 0, saved: ['2026-08-30'] });
  check('one missed day: the streak survives it', w.studyStreak(), 4);
}
{
  const w = makeWorld(TODAY, { activity: ['2026-08-26','2026-08-27','2026-08-28'] });
  w.refreshStreakSaves();
  check('a two-day gap is not half-bridged', state(w), { count: 1, saved: [] });
}

// ---- 31 August 2026: the laptop and the phone --------------------------------
// The laptop was last used on the 29th. Lasz spent the 30th on his phone, 54
// reviews. He opens the laptop on the 31st, and before sync has read a byte the
// laptop's own copy of the truth says the 30th was a day off.
{
  const stale = ['2026-08-27','2026-08-28','2026-08-29'];
  const w = makeWorld(TODAY, { activity: stale, settled: false });
  w.refreshStreakSaves();
  check('before sync has read: the kunai is held', state(w), { count: 1, saved: [] });
  check('before sync has read: nothing is written', w.writes, 0);

  // Sync lands, bringing the phone's day with it, and the dashboard redraws.
  w.activityDates = stale.concat(['2026-08-30']);
  w.remoteDataSettled = function(){ return true; };
  w.refreshStreakSaves();
  check('after sync has read: still held', state(w), { count: 1, saved: [] });
  check('after sync has read: the streak has all four days', w.studyStreak(), 4);
}

// ---- Repairing a kunai already spent -----------------------------------------
// What Lasz is holding now. The laptop covered the 30th, the spend reached the
// server, and the 54 reviews arrived afterwards.
{
  const w = makeWorld(TODAY, {
    activity: ['2026-08-27','2026-08-28','2026-08-29','2026-08-30'],
    saves: { count: 0, lastEarned: TODAY, savedDates: ['2026-08-30'] }
  });
  w.refreshStreakSaves();
  check('a kunai spent on a day that was studied comes back',
        state(w), { count: 1, saved: [] });
  check('the refund is written', w.writes, 1);
  check('the streak is unharmed by the refund', w.studyStreak(), 4);
}
{
  // mergeDates is a union, so it can only ever put a date back. The refund has
  // to survive meeting a device that has not made it yet.
  const w = makeWorld(TODAY, {
    activity: ['2026-08-27','2026-08-28','2026-08-29','2026-08-30'],
    saves: { count: 1, lastEarned: TODAY, savedDates: ['2026-08-30'] }
  });
  w.refreshStreakSaves();
  check('a refunded date coming back over sync does not grant a second kunai',
        state(w), { count: 1, saved: [] });
}
{
  // A day genuinely missed keeps its cover: the refund must not undo real work.
  const w = makeWorld(TODAY, {
    activity: ['2026-08-27','2026-08-28','2026-08-29'],
    saves: { count: 0, lastEarned: TODAY, savedDates: ['2026-08-30'] }
  });
  w.refreshStreakSaves();
  check('a real save is left alone', state(w), { count: 0, saved: ['2026-08-30'] });
  check('a real save is not rewritten', w.writes, 0);
}
{
  // Refund first, spend second, so one pass can do both.
  const w = makeWorld('2026-09-02', {
    activity: ['2026-08-29','2026-08-30','2026-08-31'],
    saves: { count: 0, lastEarned: '2026-08-31', savedDates: ['2026-08-30'] }
  });
  w.refreshStreakSaves();
  check('a refunded kunai can cover the day that is actually missing',
        state(w), { count: 0, saved: ['2026-09-01'] });
  check('and the streak is whole', w.studyStreak(), 4);
}

// ---- The guard must not strand anyone ----------------------------------------
{
  const w = makeWorld(TODAY, {
    activity: ['2026-08-27','2026-08-28','2026-08-29'], noSyncLayer: true
  });
  w.refreshStreakSaves();
  check('with sync.js absent the kunai still works',
        state(w), { count: 0, saved: ['2026-08-30'] });
}

console.log(failures === 0 ? '\nAll cases passed.' : '\n' + failures + ' failed.');
process.exit(failures ? 1 : 0);
