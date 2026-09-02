// Cross-device sync via Supabase.
//
// The publishable key below is meant to ship in the client, it identifies the
// project, it doesn't authorise anything on its own. Privacy comes from the
// row-level security policies in supabase/schema.sql, so that SQL must be run
// before sync will work (or do anything safe).
//
// Loaded before app.js. Functions here read and assign app.js's top-level
// bindings, which is fine because they only ever run after app.js has executed.

const SUPABASE_URL = 'https://uozdxhcyxwnyqrplwokr.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_SztWNK2e8Ijq4tkSNtgllQ_-FZbgeDv';
const DIRTY_KEY = 'kaishi-sync-dirty';
// The last state this device and the server agreed on, per account, so a sync
// can tell which side changed rather than having to pick a winner. See the
// base section below for why nothing works properly without it.
const BASE_KEY_PREFIX = 'kaishi-sync-base:';
// What the last write sent, kept until its reply is heard. See landedUnheard.
const PENDING_KEY_PREFIX = 'kaishi-sync-pending:';
// Set only by a deliberate local erasure, which is the one case where this
// device's copy should replace the server's rather than merge with it.
const FORCE_KEY = 'kaishi-sync-force-local';
const PUSH_DEBOUNCE_MS = 1500;

let sb = null;
let syncUser = null;
// False until getSession() has come back, so the app can tell "signed out"
// apart from "we have not looked yet". app.js renders before initSync has
// restored the session, and pullRemote only repaints when the data actually
// changed, which on a plain refresh it has not. Without this the dashboard
// kept showing "sign in to sync" to somebody already signed in.
let syncChecked = false;
// True once the sync layer has finished its first pass: either there is nobody
// signed in, or there is and we have tried to read their row. The streak reads
// it before spending a kunai. See applyStreakSaves in app.js for why.
let syncSettled = false;
function remoteDataSettled(){ return syncSettled; }
let syncStatus = 'off'; // 'off' | 'signing-in' | 'syncing' | 'synced' | 'error'
let syncDetail = '';
let syncNotice = ''; // one-off message shown on the Settings screen
let pushTimer = null;
let applyingRemote = false;

function syncActive(){ return !!(sb && syncUser); }

// Local edits are flagged in localStorage rather than memory so that changes
// made offline (or in a tab that was closed before the push landed) are still
// known to be unpushed on the next load.
// A token rather than a flag. clearDirty used to wipe the mark whenever any
// push finished, so an edit made while a push was in flight had its mark
// cleared by that older request and was never sent: the edit survives locally
// and silently never reaches the server. The token records which edit a push
// actually carried, and only that one is cleared.
//
// The tab's own id is part of it, and that is not decoration. A bare counter
// starts at zero in every tab, so two tabs each writing their first mark both
// write "1", and whichever finishes a sync first clears the other's mark and
// takes its edit with it. The mark has to say *which* edit it is, and an edit
// belongs to a tab. Counting alone cannot express that, because the thing being
// counted is per tab and the thing being read is per origin.
const TAB_ID = (function(){
  try{
    if(window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  }catch(e){}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
})();
let dirtyToken = 0;
function markDirty(){
  if(applyingRemote) return; // writing pulled data back out isn't a local edit
  dirtyToken++;
  try{ window.localStorage.setItem(DIRTY_KEY, TAB_ID + ':' + dirtyToken); }catch(e){}
  if(syncActive()) schedulePush();
}
function isDirty(){
  try{ return !!window.localStorage.getItem(DIRTY_KEY); }catch(e){ return false; }
}
// The mark as it stood when a push began, so the push can tell afterwards
// whether anything happened while it was away.
function dirtyMark(){
  try{ return window.localStorage.getItem(DIRTY_KEY); }catch(e){ return null; }
}
function clearDirty(mark){
  // Only clear the exact mark that was pushed. If it moved on while the request
  // was in flight there is a newer edit still waiting, and wiping it here would
  // lose it for good.
  try{
    if(mark !== undefined && dirtyMark() !== mark) return;
    window.localStorage.removeItem(DIRTY_KEY);
  }catch(e){}
}

// Updates the badge in place instead of calling render(), because a push can
// finish while an answer is half-typed and re-rendering would wipe the input.
function setSyncStatus(status, detail){
  syncStatus = status;
  syncDetail = detail || '';
  const el = document.getElementById('syncbadge');
  if(!el) return;
  const labels = {
    'off': '', 'signing-in': 'Signing in…', 'syncing': 'Syncing…',
    'synced': 'Synced', 'error': syncDetail || 'Sync error'
  };
  const text = labels[status] || '';
  el.textContent = text;
  el.hidden = !text;
  el.className = 'syncbadge' + (status==='error' ? ' err' : '');
}

// The seven fields that make up a saved state, in the shape the table stores
// them. localSnapshot is what this device believes; rowSnapshot is what the
// server sent back, with the gaps filled in so a row written by an older
// version of the app still merges.
function localSnapshot(){
  return {
    progress: progress,
    settings: settings,
    mistakes: mistakes,
    activity_dates: activityDates,
    review_history: reviewHistory,
    daily_lessons: dailyLessons,
    streak_saves: streakSaves
  };
}

function rowSnapshot(row){
  return {
    progress:       row.progress       || {},
    settings:       row.settings       || {},
    mistakes:       row.mistakes       || [],
    activity_dates: row.activity_dates || [],
    review_history: row.review_history || {},
    daily_lessons:  row.daily_lessons  || { date: todayKey(), count: 0 },
    streak_saves:   validStreak(row.streak_saves) ? row.streak_saves : null
  };
}

function validStreak(s){ return !!s && typeof s.count === 'number'; }

// ---- The base: what this device and the server last agreed on ---------------
//
// Without it a sync can see that the two copies differ and cannot tell which
// side moved, so the only options are to overwrite one or to guess. With it,
// every field is a three-way merge: whichever side differs from the base is
// the side that changed, and only a field both sides moved needs a rule.
//
// Kept per account, because signing into a different one must not reconcile
// against somebody else's agreement.
function baseKey(){ return BASE_KEY_PREFIX + (syncUser ? syncUser.id : 'anon'); }

function loadBase(){
  try{
    const raw = window.localStorage.getItem(baseKey());
    if(!raw) return null;
    const b = JSON.parse(raw);
    return b && b.snapshot ? b.snapshot : null;
  }catch(e){ return null; }
}

function saveBase(revision, snapshot){
  try{
    window.localStorage.setItem(baseKey(), JSON.stringify({
      revision: (revision === undefined ? null : revision),
      snapshot: snapshot
    }));
  }catch(e){}
}

function clearSyncBase(){
  try{
    window.localStorage.removeItem(baseKey());
    window.localStorage.removeItem(PENDING_KEY_PREFIX + (syncUser ? syncUser.id : 'anon'));
    window.localStorage.removeItem(FORCE_KEY);
  }catch(e){}
}

// ---- A write we sent but never heard back about ----------------------------
//
// The server can commit a write and the reply never arrive: the tab is closing,
// the connection drops, the phone changes network. The base is then still the
// old one while the server has already moved on, and because several fields
// merge by adding each side's gain to the base, the next reconcile adds the
// same reviews a second time. Twelve reviews become nineteen.
//
// So before every write, what is being sent and the revision it should produce
// are recorded. If the next read finds exactly that revision holding exactly
// that content, the write did land, and this is the base to reconcile against
// rather than the older one. Both halves have to match: the revision alone
// could be another device's write, and the content alone could be a coincidence
// at the wrong revision.
//
// It is per account for the same reason the base is.
function pendingKey(){ return PENDING_KEY_PREFIX + (syncUser ? syncUser.id : 'anon'); }

function savePending(revision, snapshot){
  try{
    window.localStorage.setItem(pendingKey(), JSON.stringify({
      revision: (revision === undefined ? null : revision), snapshot: snapshot
    }));
  }catch(e){}
}

function loadPending(){
  try{
    const raw = window.localStorage.getItem(pendingKey());
    if(!raw) return null;
    const p = JSON.parse(raw);
    return p && p.snapshot ? p : null;
  }catch(e){ return null; }
}

function clearPending(){
  try{ window.localStorage.removeItem(pendingKey()); }catch(e){}
}

// Did the write we never heard back about actually land? If so its snapshot is
// what this device and the server last agreed on, whatever the stored base says.
function landedUnheard(pending, row, remote){
  if(!pending) return false;
  if(pending.revision !== null && row.revision !== pending.revision) return false;
  return sameData(remote, pending.snapshot);
}

// "Reset all progress" is a deliberate erasure. A merge would treat the emptied
// state as fields this device happened not to have and hand them straight back
// from the server, so that path says plainly that local wins this once. The
// mark survives a reload, because a reset may well be followed by one before
// sync gets a turn.
function syncForceLocal(){
  try{ window.localStorage.setItem(FORCE_KEY, '1'); }catch(e){}
  try{ window.localStorage.removeItem(baseKey()); }catch(e){}
  if(typeof markDirty === 'function') markDirty();
}
function forcingLocal(){
  try{ return window.localStorage.getItem(FORCE_KEY) === '1'; }catch(e){ return false; }
}

// ---- Merging ---------------------------------------------------------------
//
// base may be null: the first sync on a device, or one whose agreement was
// cleared. Then there is no way to tell a change from a value that was always
// there, so every rule falls back to the version that cannot lose work. The
// merge is allowed to be a little generous rather than a little lossy.

function mergeSnapshots(base, local, remote){
  const b = base || null;
  // The streak needs this, not just the snapshot: a kunai spent on a day that
  // either device turns out to have studied was never needed. See
  // canonicalStreak.
  const activity = mergeDates(local.activity_dates, remote.activity_dates);
  return {
    progress:       mergeProgress(b && b.progress, local.progress, remote.progress),
    settings:       mergeSettings(b && b.settings, local.settings, remote.settings),
    mistakes:       mergeMistakes(local.mistakes, remote.mistakes),
    activity_dates: activity,
    review_history: mergeCounts(b && b.review_history, local.review_history, remote.review_history),
    daily_lessons:  mergeDailyLessons(b && b.daily_lessons, local.daily_lessons, remote.daily_lessons),
    streak_saves:   mergeStreakSaves(b && b.streak_saves, local.streak_saves,
                                     remote.streak_saves, activity)
  };
}

function mergeProgress(base, local, remote){
  const out = {};
  const ids = new Set(Object.keys(local || {}).concat(Object.keys(remote || {})));
  for(const id of ids){
    const l = local[id], r = remote[id];
    // An item only ever appears; nothing in the app removes one except a reset,
    // and a reset takes the forceLocal path rather than this one. So a side
    // that lacks an item has not learned it yet, it has not deleted it.
    if(!l){ out[id] = r; continue; }
    if(!r){ out[id] = l; continue; }
    if(sameData(l, r)){ out[id] = l; continue; }
    if(base){
      const b = base[id];
      if(sameData(b, l)){ out[id] = r; continue; }   // only the server moved it
      if(sameData(b, r)){ out[id] = l; continue; }   // only this device did
    }
    out[id] = pickEntry(l, r);
  }
  return out;
}

// Both sides moved the same card since they last agreed. The write stamp says
// which decision came second. Entries written before stamps existed have none,
// and then the lower stage wins: repeating a review costs one review, while
// keeping the higher stage lets a card the user has just forgotten vanish for
// months. Deliberately not "furthest advanced": a failed review is supposed to
// demote a card, and that demotion is real information about the user.
function pickEntry(l, r){
  const lt = typeof l.t === 'number' ? l.t : null;
  const rt = typeof r.t === 'number' ? r.t : null;
  if(lt !== null && rt !== null) return lt >= rt ? l : r;
  if(lt !== null) return l;
  if(rt !== null) return r;
  return (l.stage || 0) <= (r.stage || 0) ? l : r;
}

// Field by field, so changing the theme here and the daily limit on the phone
// keeps both.
function mergeSettings(base, local, remote){
  const out = {};
  const keys = new Set(Object.keys(local || {}).concat(Object.keys(remote || {})));
  for(const k of keys){
    const inL = Object.prototype.hasOwnProperty.call(local, k);
    const inR = Object.prototype.hasOwnProperty.call(remote, k);
    if(!inR){ out[k] = local[k]; continue; }
    if(!inL){ out[k] = remote[k]; continue; }
    if(sameData(local[k], remote[k])){ out[k] = local[k]; continue; }
    if(base && sameData(base[k], local[k])){ out[k] = remote[k]; continue; }
    out[k] = local[k];   // both moved, or nothing to compare it with
  }
  return out;
}

// Timestamps are milliseconds, so an id, a type and a time identify one miss.
function mergeMistakes(local, remote){
  const seen = new Set();
  const out = [];
  for(const m of (local || []).concat(remote || [])){
    if(!m || typeof m.timestamp !== 'number') continue;
    const k = m.id + '|' + (m.type || 'meaning') + '|' + m.timestamp;
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

function mergeDates(local, remote){
  return Array.from(new Set((local || []).concat(remote || []))).sort();
}

// Counts per day. Both devices may have reviewed since they last agreed, so
// the two gains are added: a maximum would report ten when each device did ten.
// Without a base there is no gain to measure and the larger of the two is the
// most that can be claimed honestly.
function mergeCounts(base, local, remote){
  const out = {};
  const keys = new Set(
    Object.keys(local || {})
      .concat(Object.keys(remote || {}))
      .concat(Object.keys(base || {}))
  );
  for(const k of keys){
    const b = base && typeof base[k] === 'number' ? base[k] : 0;
    const l = typeof local[k]  === 'number' ? local[k]  : b;
    const r = typeof remote[k] === 'number' ? remote[k] : b;
    // Two copies that already agree are not evidence of anybody having gained
    // anything, whatever the base says, and a base can be older than it should
    // be: a write can land with its reply lost, or saveBase can fail silently
    // when storage is full. Adding both differences there invents reviews that
    // were never done, and it does it every sync until the base catches up.
    // Two devices each doing exactly the same number of reviews since the base
    // is the case this gets wrong, and it reports the smaller true-ish number
    // rather than a larger invented one, which is the right way round for a
    // statistic nothing depends on.
    if(l === r){ out[k] = l; continue; }
    out[k] = base ? b + Math.max(0, l - b) + Math.max(0, r - b) : Math.max(l, r);
  }
  return out;
}

// Only today's count means anything. An older one belongs to a device that has
// not noticed the date turn over yet, and its number must not be added to
// today's.
function mergeDailyLessons(base, local, remote){
  const today = todayKey();
  const count = s => (s && s.date === today && typeof s.count === 'number') ? s.count : 0;
  const b = count(base), l = count(local), r = count(remote);
  if(l === r) return { date: today, count: l };   // see mergeCounts
  return { date: today, count: base ? b + Math.max(0, l - b) + Math.max(0, r - b) : Math.max(l, r) };
}

// A kunai covering a day that was studied was never spent, so this rewrites the
// state to what it would have been had the device known.
//
// It exists because refundUnneededSaves in app.js does the same thing locally,
// and doing it only locally was wrong twice over. mergeDates is a union, so a
// date the dashboard removes is put straight back by the next merge and never
// leaves the server. And the arithmetic below measures spending by the *length*
// of savedDates, on the assumption that the array only grows; a refund that
// swaps one date for another is invisible to it, so a device that refunded and
// a device that refunded and then covered a real day merged to a kunai in hand
// that had already been spent. Codex found both, in brief 020.
//
// Canonicalising all three sides before measuring fixes both, because the
// refund stops being a change any side has to account for: it is applied to the
// base as well, so it is not a movement away from it.
function canonicalStreak(s, studied){
  if(!validStreak(s)) return s;
  const dates = s.savedDates || [];
  const keep = dates.filter(k => !studied.has(k));
  if(keep.length === dates.length) return s;
  return {
    count: Math.min(STREAK_SAVE_MAX, s.count + (dates.length - keep.length)),
    lastEarned: s.lastEarned,
    savedDates: keep
  };
}

// count, lastEarned and savedDates are one piece of state, so they are merged
// as one. Granting and spending are both movements away from the base and both
// are kept; the cap stops two devices each granting the same kunai.
function mergeStreakSaves(base, local, remote, activity){
  if(!validStreak(remote)) return local;
  if(!validStreak(local))  return remote;
  // Before anything is measured, so that a refund is never mistaken for a
  // spend or a grant. activity may be missing when this is called directly.
  const studied = new Set(activity || []);
  base   = canonicalStreak(base, studied);
  local  = canonicalStreak(local, studied);
  remote = canonicalStreak(remote, studied);
  const savedDates = mergeDates(local.savedDates, remote.savedDates);
  const lastEarned = [local.lastEarned, remote.lastEarned].filter(Boolean).sort().pop() || todayKey();
  let count;
  if(validStreak(base)){
    // Adding the two differences straight was wrong, and the case that shows it
    // is one device replenishing and holding while the other replenishes the
    // same entitlement and spends it. Both sides moved by +1 and -1+1, the
    // deltas cancel, and the merge hands back a kunai that has already been
    // spent: one grant that both covered a day and stayed in hand.
    //
    // Grants and spends are not the same kind of thing, so they are not counted
    // the same way. A spend leaves evidence — a date in savedDates — so the
    // spends are the dates that have appeared since the base, and every one of
    // them is real. A grant leaves none, and both devices replenishing is the
    // same entitlement arriving twice rather than two entitlements, so the
    // grants are the larger of the two sides rather than their sum.
    const baseDates = (base.savedDates || []).length;
    const spent     = Math.max(0, savedDates.length - baseDates);
    const gain = side => Math.max(0,
      side.count + Math.max(0, (side.savedDates || []).length - baseDates) - base.count);
    count = base.count + Math.max(gain(local), gain(remote)) - spent;
  }else{
    count = Math.min(local.count, remote.count);   // never grant one nothing accounts for
  }
  // Two stale devices can spend on two different days from one kunai. The union
  // keeps both dates and the count floors at zero, so the streak gets a day it
  // did not strictly pay for. The shape cannot represent which grant a spend
  // belongs to, and erring towards the user's streak is the right way to be
  // wrong about it.
  count = Math.max(0, Math.min(STREAK_SAVE_MAX, count));
  return { count: count, lastEarned: lastEarned, savedDates: savedDates };
}

// Writes a merged snapshot into this device's own state. None of it is a local
// edit, so markDirty stays out of the way while it happens.
function applyMerged(snap){
  progress      = snap.progress;
  settings      = Object.assign({}, DEFAULT_SETTINGS, snap.settings);
  mistakes      = snap.mistakes;
  activityDates = snap.activity_dates;
  reviewHistory = snap.review_history;
  dailyLessons  = snap.daily_lessons;
  if(validStreak(snap.streak_saves)) streakSaves = snap.streak_saves;
  if(dailyLessons.date !== todayKey()) dailyLessons = { date: todayKey(), count: 0 };
  applyingRemote = true;
  try{
    saveProgress(); saveSettings(); saveMistakes(); saveActivity();
    saveStreakSaves(); saveReviewHistory(); saveDailyLessons();
  }finally{
    applyingRemote = false;
  }
  // The document has to follow the settings, not just the variable. Here rather
  // than at the call site so it cannot be forgotten by the next caller.
  //
  // Codex found this in brief 019 and it is worse than a stale colour:
  // renderTiersSection branches on settings.palette, so a device that was on
  // Classic and receives Ember would draw the scroll markup while the root
  // still said data-skin="plain", with none of the rules that markup needs.
  applyTheme();
}

async function initSync(){
  if(typeof supabase === 'undefined'){
    setSyncStatus('error', 'Sync library failed to load');
    // Nothing is ever going to arrive, so the streak may as well stop waiting.
    syncSettled = true;
    return;
  }
  // In its own try, and not in the one below, because the finally there raises
  // syncChecked as well. A client that cannot even be constructed is the same
  // situation as the library not loading at all: there is no point offering a
  // sign-in that cannot work. What must happen either way is syncSettled, or
  // applyStreakSaves waits for a pull that is never coming and the kunai is
  // never spent again on this device. init() swallows what initSync throws, so
  // nothing further up would notice.
  try{
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  }catch(e){
    setSyncStatus('error', 'Sync library failed to load');
    syncSettled = true;
    return;
  }

  try{
    const { data: { session } } = await sb.auth.getSession();
    if(session && session.user){
      syncUser = session.user;
      await syncNow();
    }
  }finally{
    // Set even if the lookup failed, or a network problem would leave the
    // dashboard permanently unable to offer sign-in at all.
    syncChecked = true;
    syncSettled = true;
  }
  // Repaint now the answer is known. app.js painted before this point, so
  // whatever it decided about the sign-in prompt was decided blind. Nothing is
  // typed this early in the load, so a repaint cannot eat an answer.
  render();

  // Synchronous on purpose, and the sync is pushed out of it with a timeout.
  //
  // supabase-js holds an auth lock for as long as this handler runs, and an
  // awaited Supabase call inside it deadlocks: the next call anywhere in the
  // app never returns, so the app looks alive and simply stops syncing until
  // the page is reloaded. Supabase document it themselves, in "Why is my
  // supabase API call not returning?", and it is open as auth-js#762.
  //
  // Deferring costs nothing here. Nothing downstream needs to happen before
  // this handler returns.
  sb.auth.onAuthStateChange((event, session) => {
    const nextUser = session && session.user ? session.user : null;
    const changed = (nextUser && nextUser.id) !== (syncUser && syncUser.id);
    syncUser = nextUser;
    if(syncUser && changed){
      setTimeout(()=>{ syncNow().then(render, render); }, 0);
    }else if(!syncUser){
      setSyncStatus('off');
    }
  });

  // Coming back to a device should pick up whatever another device wrote.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible' && syncActive()) syncNow();
    else if(document.visibilityState === 'hidden') syncOnTheWayOut();
  });
  // Backgrounding an app on a phone fires visibilitychange; navigating away or
  // closing the tab fires pagehide and may not fire the other one at all.
  window.addEventListener('pagehide', syncOnTheWayOut);
}

// Leaving is the one moment the debounce cannot cover. An answer given a second
// before the tab is closed is saved here but not yet sent, and nothing sends it
// until the app is next opened on this device, so a morning on the phone can
// reach the afternoon's PC one answer short.
//
// It is a try rather than a guarantee, and deliberately not more than that. The
// browser is free to kill an in-flight request as the page goes away, and the
// only way round that is sendBeacon or a keepalive fetch, neither of which can
// read a reply. A write that cannot read the reply cannot tell whether its
// compare and swap matched, which would mean giving up the protection that
// stops two devices overwriting each other to save one round trip. Not a trade
// worth making: the dirty mark already covers whatever this misses, and the
// merge means a late answer is folded in rather than lost.
function syncOnTheWayOut(){
  if(syncActive() && isDirty()) syncNow();
}

// Deep equality that ignores key order. Everything here round-trips through a
// jsonb column, and Postgres orders object keys by length then bytewise rather
// than preserving insertion order. So an entry written as
// {stage, nextReview, unlocked, m, r} comes back as {m, r, stage, unlocked,
// nextReview} with identical data, and a raw JSON.stringify comparison calls
// that a change. It used to, and the cost was an in-progress lesson being
// thrown away by a pull that changed nothing.
function sameData(a, b){
  if(a === b) return true;
  if(a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if(Array.isArray(a) !== Array.isArray(b)) return false;
  if(Array.isArray(a)){
    return a.length === b.length && a.every((v, i) => sameData(v, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if(ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameData(a[k], b[k]));
}

// Which in-flight session, if any, a reconcile has invalidated.
//
// The old rule discarded all three whenever progress differed at all, so a
// change to an unrelated card ended someone's lesson. What actually matters is
// whether the merge moved ground the session is standing on.
function invalidateSessionsAfterPull(before, after){
  const changed = id => !sameData(before[id], after[id]);

  // A lesson in its study phase has decided nothing. Its words are stage 0 on
  // both sides and no SRS state depends on it, so a merge elsewhere in the deck
  // must not cost the user their place. Only a batch word that has stopped
  // being new invalidates it, which means another device taught it.
  if(lessonState){
    const batch = lessonState.batch || [];
    const mine  = lessonState.phase === 'quiz'
      ? batch.some(changed)                     // some may already be committed
      : batch.some(id => (after[id] || {}).stage);
    if(mine) lessonState = null;
  }

  // A review session's queue and results describe stages that must still be
  // the ones it started from. Only its own items matter.
  if(reviewState){
    const ids = Object.keys(reviewState.results || {});
    if(ids.some(changed)) reviewState = null;
  }

  // Extra study is a read-only drill over recent mistakes. It writes no SRS
  // decisions at all, so nothing a merge brings back can invalidate it.
}

// ---- Reconciling -----------------------------------------------------------
//
// One rule, and it replaces the old one: the dirty mark means there is
// something to reconcile, never that this device's copy is authoritative.
//
// The old code read `if(isDirty()) push else pull`, and a push wrote all seven
// fields over whatever was there. So any device holding an unpushed change
// replaced the server's copy with its own, sight unseen, including a device
// that had marked itself dirty at boot simply by noticing the date had turned
// over. A morning of study died that way on 27 August 2026: the laptop woke
// holding yesterday, marked itself dirty rolling the day over, and wrote
// yesterday over the top of it.
//
// So: always read first, merge against the base, and write the result back only
// if the row has not moved since it was read. If it has, the merge was against
// a copy that is no longer current, so read and merge again rather than insist.
const CAS_RETRIES = 4;

async function syncNow(){
  if(!syncActive()) return;
  setSyncStatus('syncing');
  return runExclusive(async ()=>{
    try{
      await reconcile();
      setSyncStatus('synced');
    }catch(e){
      // Say what went wrong. This used to discard e entirely, so a genuine
      // crash inside reconcile was indistinguishable from a dropped
      // connection: the app said "working offline" and there was nothing
      // anywhere to say otherwise. A missing function in applyMerged looked
      // exactly like a flaky train.
      if(typeof console !== 'undefined' && console.warn) console.warn('Emaki sync failed', e);
      setSyncStatus('error', 'Sync failed, working offline');
    }
  });
}

async function reconcile(){
  for(let attempt = 0; attempt < CAS_RETRIES; attempt++){
    const { data, error } = await sb
      .from('user_state').select('*').eq('user_id', syncUser.id).maybeSingle();
    if(error) throw error;

    // Read after the request comes back, so it accounts for anything answered
    // while it was in flight, and captured alongside the copy it describes.
    const mark    = dirtyMark();
    const local   = localSnapshot();
    const forcing = forcingLocal();

    let row, merged;

    if(!data){
      // Nobody has written for this account yet.
      merged = local;
      row = await writeRemote(local, 'seed');
      if(!row) continue;             // somebody seeded first: read theirs
    }else{
      const remote  = rowSnapshot(data);
      const pending = loadPending();
      // A write of ours that landed while the reply was lost is what we last
      // agreed on, whatever the stored base still says.
      const base = landedUnheard(pending, data, remote) ? pending.snapshot : loadBase();
      merged = forcing ? local : mergeSnapshots(base, local, remote);

      if(sameData(merged, remote)){
        row = data;                  // nothing to say
      }else{
        const revision = (data.revision === undefined ? null : data.revision);
        savePending(revision === null ? null : revision + 1, merged);
        row = await writeRemote(merged, revision);
        if(!row) continue;           // the row moved under us: read it again
      }
    }

    clearPending();

    // What the server is actually holding now. The base has to be this and not
    // `merged`, because a write can be trimmed on the way out — the streak_saves
    // fallback drops a field — and a base describing something the server never
    // stored makes the next merge wrong rather than merely late.
    const stored = rowSnapshot(row);
    saveBase(row.revision, stored);

    // Anything answered while that write was away is newer than what we sent
    // and newer than the picture we are holding. Writing `stored` over it here
    // would revert it: the mark would survive and sync it back eventually, but
    // the answer would be gone from this screen in the meantime, and a reset
    // caught this way would simply undo itself. So leave local alone, leave the
    // mark alone, and come back for it.
    if(dirtyMark() !== mark){
      schedulePush();
      return;
    }

    if(!sameData(stored, local)){
      const before = JSON.parse(JSON.stringify(progress));
      applyMerged(stored);
      invalidateSessionsAfterPull(before, progress);
      // Only repaint when something actually changed, so a background sync
      // cannot clear an answer the user is midway through typing.
      render();
    }
    clearTimeout(pushTimer);
    clearDirty(mark);
    if(forcing){ try{ window.localStorage.removeItem(FORCE_KEY); }catch(e){} }
    return;
  }
  throw new Error('Could not reconcile: the server copy kept moving');
}

// Compare and swap. The update only matches while revision is still what the
// read returned, so two devices cannot both merge against the same copy and
// have the second one silently win. A null result means no row matched, which
// here means somebody else wrote first.
//
// mode is 'seed' when the read found no row at all, a revision number to
// compare and swap on, or null for a live table that predates the revision
// column, where the merge still happens but the write is unprotected.
//
// Seeding inserts rather than upserts. Two devices signing in to a new account
// can both read nothing and both write; an upsert makes the second one silently
// replace the first one's row, which is the very thing the rest of this file
// exists to prevent. An insert against an existing primary key is a conflict
// instead, and a conflict means somebody seeded first, so read theirs and merge.
async function writeRemote(snap, mode){
  const fields = Object.assign({}, snap);
  if(!validStreak(fields.streak_saves)) delete fields.streak_saves;

  const run = async (payload) => {
    if(mode === 'seed'){
      return await sb.from('user_state')
        .insert(Object.assign({ user_id: syncUser.id }, payload))
        .select().maybeSingle();
    }
    if(mode === null || mode === undefined){
      return await sb.from('user_state')
        .upsert(Object.assign({ user_id: syncUser.id }, payload), { onConflict: 'user_id' })
        .select().maybeSingle();
    }
    return await sb.from('user_state')
      .update(payload).eq('user_id', syncUser.id).eq('revision', mode)
      .select().maybeSingle();
  };

  let { data, error } = await run(fields);
  // streak_saves was added after the original schema. Until the ALTER TABLE in
  // supabase/schema.sql has been run, drop that one field and sync the rest
  // rather than letting the whole write fail.
  if(error && /streak_saves/.test(error.message || '')){
    const trimmed = Object.assign({}, fields);
    delete trimmed.streak_saves;
    ({ data, error } = await run(trimmed));
  }
  // A seed that collided is not a failure. Somebody else created the row
  // between our read and our write, so there is something to merge with after
  // all: report it the same way a lost compare and swap is reported, and the
  // loop will read it.
  if(error && mode === 'seed' && isDuplicateRow(error)) return null;
  if(error) throw error;
  return data || null;
}

// Postgres reports a primary key collision as 23505. PostgREST passes the code
// through, but not every layer does, so the message is checked too.
function isDuplicateRow(error){
  if(!error) return false;
  if(error.code === '23505') return true;
  return /duplicate key|already exists/i.test(error.message || '');
}

// Single-flight. Two writes in the air at once are not ordered by the server,
// so the older one can land last. Compare and swap catches that between
// devices; this keeps one device from making the server do that work.
let inFlight = null;

function runExclusive(fn){
  const next = (inFlight || Promise.resolve()).then(fn, fn);
  inFlight = next.catch(()=>{});
  return next;
}

function schedulePush(){
  clearTimeout(pushTimer);
  pushTimer = setTimeout(()=>{
    if(!syncActive()) return;
    // A reconcile may already have carried this edit. Firing anyway used to
    // mean writing a snapshot nobody had asked to write, over a row another
    // device had moved on in the meantime.
    if(!isDirty()) return;
    setSyncStatus('syncing');
    runExclusive(async ()=>{
      try{
        await reconcile();
        setSyncStatus('synced');
      }catch(e){
        setSyncStatus('error', 'Sync failed, working offline');
      }
    });
  }, PUSH_DEBOUNCE_MS);
}

async function signInWithEmail(){
  const el = document.getElementById('syncEmailInput');
  const email = el ? el.value.trim() : '';
  if(!email) return;
  if(!sb){ setSyncStatus('error', 'Sync unavailable'); return; }
  setSyncStatus('signing-in');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] }
  });
  if(error){
    setSyncStatus('error', error.message);
    syncNotice = 'Could not send the link: ' + error.message;
  }else{
    setSyncStatus('off');
    syncNotice = 'Check ' + email + ' for a sign-in link.';
  }
  render();
}

// A magic link means an email round trip on every new device, which is a lot of
// friction for someone signing in on a phone. These are the alternative.
//
// Each provider has to be switched on in the Supabase dashboard first
// (Authentication -> Providers) and the callback URL added there, otherwise the
// call comes back as an error rather than a redirect. Keep this list matching
// whatever is actually enabled, or the app offers buttons that cannot work.
// GitHub first on purpose. Its consent screen names the app ("to continue to
// Emaki"), because GitHub shows the OAuth app name you registered. Google shows
// the callback domain instead, which is the Supabase project ref until there is
// a custom domain on it, and a random string on a sign-in page reads as
// phishing to somebody who has never seen this app before. Put the one that
// looks trustworthy first and revisit when the domain lands.
const OAUTH_PROVIDERS = [
  { id: 'github', label: 'Continue with GitHub' },
  { id: 'google', label: 'Continue with Google' }
];

async function signInWithProvider(provider){
  if(!sb){ setSyncStatus('error', 'Sync unavailable'); return; }
  setSyncStatus('signing-in');
  const { error } = await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.href.split('#')[0] }
  });
  // On success the browser has already navigated away, so there is nothing
  // left to do here and no success branch to write.
  if(error){
    setSyncStatus('error', error.message);
    syncNotice = 'Could not start sign-in with ' + provider + ': ' + error.message;
    render();
  }
}

// Removes the synced copy and signs out. The row goes via the "delete own
// state" policy in supabase/schema.sql; without that policy this reports
// success and deletes nothing, because RLS denies by default and PostgREST
// does not distinguish "no rows matched" from "not allowed".
//
// It does not remove the row in auth.users, which holds the email address.
// That needs the service key and so an Edge Function, which this app does not
// have. The UI says so rather than implying a completeness it cannot deliver.
async function deleteRemoteData(){
  if(!sb || !syncUser) return { ok: false, error: 'Not signed in' };
  const { error } = await sb.from('user_state').delete().eq('user_id', syncUser.id);
  if(error) return { ok: false, error: error.message };
  // Confirm it actually went, rather than trusting a silent no-op.
  const { data, error: readErr } = await sb
    .from('user_state').select('user_id').eq('user_id', syncUser.id).maybeSingle();
  if(readErr) return { ok: false, error: readErr.message };
  if(data) return { ok: false, error: 'The server still has a copy. Has the delete policy in schema.sql been run?' };
  return { ok: true };
}

// scope 'global' ends the session on every device rather than just this one.
// Used by the delete path: the row can be removed here and put straight back by
// another device that is still signed in, still holds the whole thing locally,
// and finds no row to merge with, so seeds one from its own copy. Signing those
// devices out stops them writing.
//
// It is a reduction in the window, not a closing of it. A device that still has
// the data will seed it again the moment somebody signs in there. Closing it
// properly needs the server to remember that a delete happened — a tombstone
// the clients honour — which is a schema change and a decision about what a
// deleted account means, not a tidy-up. Until then the UI says what actually
// happens rather than implying more.
async function signOutSync(scope){
  if(!sb) return;
  try{
    await sb.auth.signOut(scope === 'global' ? { scope: 'global' } : undefined);
  }catch(e){
    // A failed sign-out must not strand the caller mid-flow; the local session
    // is dropped either way.
  }
  syncUser = null;
  setSyncStatus('off');
  syncNotice = 'Signed out. Progress stays on this device.';
  render();
}
