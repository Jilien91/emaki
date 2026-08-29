// Drives the real reconcile() in sync.js against a Supabase client that can be
// interfered with mid-request.
//
//   node scripts/sync-reconcile-test.js
//
// The companion to sync-merge-test.js, and the more important of the two. That
// one checks the merge rules, which are pure functions and easy to reason
// about. Every sync bug that has actually cost Lasz anything has instead been
// about *when* things happen: a device that pushed before it read, an edit made
// while a request was in flight, two tabs that share a dirty mark but not their
// memory. None of that is visible to a test that calls mergeSnapshots directly,
// which is exactly why the first round of them survived a morning of testing on
// 27 August 2026 and were found by Codex the same evening.
//
// A tab is a whole separate copy of sync.js in its own vm context, with its own
// module state, sharing one localStorage object with the others. That is what a
// second browser tab actually is, so cross-tab bugs reproduce here rather than
// having to be argued about.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SYNC = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
const TODAY = '2026-08-27';

// ---- A server that can be got at while it is thinking -----------------------
function makeServer(){
  const server = {
    row: null,
    reads: 0,
    writes: 0,
    // Runs inside a write, after the client has decided what to send and before
    // the reply comes back. This is the window an answer can land in.
    onWrite: null,
    // Make the next N conditional writes miss, as if another device got there.
    failWrites: 0,
    // Commit the write but lose the reply, as a closing tab or a dropped
    // connection does.
    loseNextReply: false,
    reset(){
      this.row = null; this.reads = 0; this.writes = 0;
      this.onWrite = null; this.failWrites = 0; this.loseNextReply = false;
    }
  };

  server.client = {
    from(){
      const q = { _op:null, _payload:null, _filters:{} };
      q.select = () => q;
      q.eq = (k, v) => { q._filters[k] = v; return q; };
      q.update = p => { q._op = 'update'; q._payload = p; return q; };
      q.upsert = p => { q._op = 'upsert'; q._payload = p; return q; };
      q.insert = p => { q._op = 'insert'; q._payload = p; return q; };
      q.delete = () => { q._op = 'delete'; return q; };
      q.maybeSingle = async () => {
        await null;                                  // a turn, as a request takes
        if(q._op === null){
          server.reads++;
          return { data: server.row ? clone(server.row) : null, error: null };
        }
        if(server.onWrite){ const f = server.onWrite; server.onWrite = null; f(); }
        await null;
        server.writes++;

        if(q._op === 'insert'){
          // Insert-only seeding: a row already there is a conflict, not an
          // overwrite. Postgres reports 23505 and PostgREST passes the code on.
          if(server.row) return { data: null, error: { code:'23505', message:'duplicate key value violates unique constraint' } };
          server.row = Object.assign({ revision: 1 }, clone(q._payload));
          return { data: clone(server.row), error: null };
        }
        if(q._op === 'update'){
          if(server.failWrites > 0){
            server.failWrites--;
            // Somebody else wrote: the row moves on and ours matches nothing.
            if(server.row) server.row.revision++;
            return { data: null, error: null };
          }
          if(!server.row || server.row.revision !== q._filters.revision){
            return { data: null, error: null };
          }
          server.row = Object.assign({}, server.row, clone(q._payload), { revision: server.row.revision + 1 });
          if(server.loseNextReply){
            server.loseNextReply = false;
            throw new Error('network lost the reply');   // committed, never heard
          }
          return { data: clone(server.row), error: null };
        }
        // upsert
        server.row = Object.assign({ revision: server.row ? server.row.revision + 1 : 1 },
                                   server.row, clone(q._payload));
        if(server.loseNextReply){
          server.loseNextReply = false;
          throw new Error('network lost the reply');
        }
        return { data: clone(server.row), error: null };
      };
      return q;
    }
  };
  return server;
}

const clone = o => JSON.parse(JSON.stringify(o));

// ---- One tab ----------------------------------------------------------------
function makeTab(store, server, name){
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Object, Array, Set, Map, Math, Date, Promise, Error, String, Number, Boolean,
    crypto: (typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto)
  };
  sandbox.window = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    addEventListener(){}
  };
  sandbox.document = { getElementById: () => null, addEventListener(){}, visibilityState:'visible' };
  sandbox.supabase = undefined;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  // Enough of app.js for sync.js to run against. The save* functions are where
  // the real ones would write localStorage and flag a change; here the globals
  // are the state, and a test answers a question by editing them and calling
  // markDirty(), which is exactly the path flagSync() takes.
  const stubs = `
    var STREAK_SAVE_MAX = 1;
    var DEFAULT_SETTINGS = { dailyNewLimit: 20, theme: 'system', lessonBatchSize: 5 };
    var progress = {}, settings = {}, mistakes = [], activityDates = [],
        reviewHistory = {}, dailyLessons = { date:'${TODAY}', count:0 },
        streakSaves = { count:1, lastEarned:'${TODAY}', savedDates:[] },
        lessonState = null, reviewState = null;
    var renders = 0;
    function todayKey(){ return '${TODAY}'; }
    function render(){ renders++; }
    function saveProgress(){} function saveSettings(){} function saveMistakes(){}
    function saveActivity(){} function saveStreakSaves(){} function saveReviewHistory(){}
    function saveDailyLessons(){}
  `;
  vm.runInContext(stubs + '\n' + SYNC, ctx, { filename: 'sync.js' });

  // Wire the tab to the shared server and give it an identity.
  vm.runInContext(`sb = __server.client; syncUser = { id: 'test-user' };`,
                  Object.assign(ctx, { __server: server }));

  const run = expr => vm.runInContext(expr, ctx);
  return {
    name,
    ctx,
    run,
    get: k => vm.runInContext(k, ctx),
    set(k, v){ ctx.__tmp = v; vm.runInContext(`${k} = __tmp;`, ctx); },
    reconcile: () => vm.runInContext('reconcile()', ctx),
    // What answering a question does: change state, then flag it.
    answer(id, stage, t){
      ctx.__e = { stage, nextReview: 1000, t };
      vm.runInContext(`progress[${id}] = __e; markDirty();`, ctx);
    },
    review(day, n){
      ctx.__n = n;
      vm.runInContext(`reviewHistory['${day}'] = __n; markDirty();`, ctx);
    }
  };
}

// ---- Harness ----------------------------------------------------------------
const results = [];
function check(name, actual, expected){
  results.push({ name, a: JSON.stringify(actual), e: JSON.stringify(expected) });
}

async function main(){

  // 1. An answer given while the write is in flight must survive.
  //
  // reconcile() captures local state and the dirty mark after the read, which
  // covers the read's own window. The write is a second await, and applyMerged
  // afterwards writes the pre-write snapshot back over memory. An answer landing
  // in that window is reverted locally even though its mark survives.
  {
    const store = {}, server = makeServer();
    const tab = makeTab(store, server, 'A');
    server.row = { user_id:'test-user', revision: 4, progress:{ 1:{stage:2,t:10} },
                   settings:{}, mistakes:[], activity_dates:[], review_history:{},
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    tab.answer(1, 3, 100);                       // something to push
    server.onWrite = () => tab.answer(99, 1, 500); // the answer during the write
    await tab.reconcile();
    check('an answer during the write survives locally',
      !!tab.get('progress[99]'), true);
    check('and is still flagged for the next sync',
      !!tab.get(`window.localStorage.getItem('kaishi-sync-dirty')`), true);
  }

  // 2. A reset during the write must not be undone, and must not have its
  //    force-local mark cleared by the older reconcile that never carried it.
  {
    const store = {}, server = makeServer();
    const tab = makeTab(store, server, 'A');
    server.row = { user_id:'test-user', revision: 2, progress:{ 1:{stage:5,t:10}, 2:{stage:4,t:11} },
                   settings:{}, mistakes:[], activity_dates:[], review_history:{},
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    tab.answer(1, 6, 100);
    server.onWrite = () => tab.run(`progress = {}; syncForceLocal();`);
    await tab.reconcile();
    check('a reset during the write is not merged away',
      Object.keys(tab.get('progress')).length, 0);
    check('and its force-local mark is still set',
      tab.get(`window.localStorage.getItem('kaishi-sync-force-local')`), '1');
  }

  // 3. Two tabs share a dirty mark but not their memory. Neither may clear a
  //    mark it did not carry. Both tabs start their counter at zero, so both
  //    write "1" for different edits.
  {
    const store = {}, server = makeServer();
    const a = makeTab(store, server, 'A');
    const b = makeTab(store, server, 'B');
    server.row = { user_id:'test-user', revision: 1, progress:{}, settings:{},
                   mistakes:[], activity_dates:[], review_history:{},
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    a.answer(1, 1, 100);                          // tab A marks dirty
    server.onWrite = () => b.answer(2, 1, 200);   // tab B marks dirty meanwhile
    await a.reconcile();
    check("tab A does not clear tab B's mark",
      !!store['kaishi-sync-dirty'], true);
  }

  // 4. Two devices signing in to an empty account at the same time. Both read
  //    no row; the second to write must find the first one's row rather than
  //    replacing it. The other device seeds here in the window between this
  //    one's read and its write, which is the whole of the race.
  {
    const store = {}, server = makeServer();
    const a = makeTab(store, server, 'A');
    a.answer(1, 1, 100);
    server.onWrite = () => {
      server.row = { user_id:'test-user', revision: 1, progress:{ 2:{stage:1,t:200} },
                     settings:{}, mistakes:[], activity_dates:[], review_history:{},
                     daily_lessons:{date:TODAY,count:0},
                     streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    };
    try{ await a.reconcile(); }catch(e){}
    check('seeding does not overwrite a row somebody else just created',
      Object.keys(server.row.progress).sort(), ['1','2']);
  }

  // 5. A write the server committed but whose reply was lost. The next
  //    reconcile must not add the same reviews a second time.
  {
    const store = {}, server = makeServer();
    const tab = makeTab(store, server, 'A');
    server.row = { user_id:'test-user', revision: 3, progress:{}, settings:{},
                   mistakes:[], activity_dates:[], review_history:{ [TODAY]: 5 },
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    tab.run(`reviewHistory['${TODAY}'] = 5;`);
    tab.run(`applyingRemote = true; try{ }finally{ applyingRemote = false; }`);
    // Agree with the server first, so there is a base.
    await tab.reconcile();
    tab.review(TODAY, 12);                        // seven more reviews here
    server.loseNextReply = true;
    try{ await tab.reconcile(); }catch(e){}       // commits, reply lost
    check('the lost write did reach the server', server.row.review_history[TODAY], 12);
    await tab.reconcile();                        // and again, once it is back
    check('a committed write whose reply was lost is not counted twice',
      server.row.review_history[TODAY], 12);
  }

  // 6. Sustained contention. Giving up is allowed; losing the edit is not.
  {
    const store = {}, server = makeServer();
    const tab = makeTab(store, server, 'A');
    server.row = { user_id:'test-user', revision: 1, progress:{}, settings:{},
                   mistakes:[], activity_dates:[], review_history:{},
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    tab.answer(1, 1, 100);
    server.failWrites = 99;
    let threw = false;
    try{ await tab.reconcile(); }catch(e){ threw = true; }
    check('four straight misses give up rather than spin', threw, true);
    check('and leave the edit flagged for the next attempt',
      !!store['kaishi-sync-dirty'], true);
    check('and do not leave a base claiming agreement',
      store['kaishi-sync-base:test-user'] === undefined, true);
  }

  // 7. The base after a write must describe what the server stored, not what
  //    this device happened to be holding when the reply arrived.
  {
    const store = {}, server = makeServer();
    const tab = makeTab(store, server, 'A');
    server.row = { user_id:'test-user', revision: 7, progress:{ 1:{stage:2,t:10} },
                   settings:{}, mistakes:[], activity_dates:[], review_history:{},
                   daily_lessons:{date:TODAY,count:0},
                   streak_saves:{count:1,lastEarned:TODAY,savedDates:[]} };
    tab.answer(1, 3, 100);
    // A review during the write that edits an entry already in the snapshot,
    // in place, the way applyReviewResult does. If the merged object is holding
    // that same entry by reference then the base records a stage the server was
    // never sent, and the next merge believes it is already up there.
    server.onWrite = () => tab.run(`progress[1].stage = 4; progress[1].t = 900; markDirty();`);
    await tab.reconcile();
    const base = JSON.parse(store['kaishi-sync-base:test-user'] || '{}');
    check('the stored base matches what the server actually stored',
      base.snapshot && base.snapshot.progress[1].stage,
      server.row.progress[1].stage);
    check('and records the revision the server returned',
      base.revision, server.row.revision);
  }

  let failed = 0;
  for(const r of results){
    const ok = r.a === r.e;
    if(!ok) failed++;
    console.log((ok ? '  ok   ' : '  FAIL ') + r.name);
    if(!ok){
      console.log('         got      ' + r.a);
      console.log('         expected ' + r.e);
    }
  }
  console.log(failed === 0
    ? '\nall ' + results.length + ' reconcile cases pass'
    : '\n' + failed + ' of ' + results.length + ' FAILED');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
