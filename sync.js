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
const PUSH_DEBOUNCE_MS = 1500;

let sb = null;
let syncUser = null;
let syncStatus = 'off'; // 'off' | 'signing-in' | 'syncing' | 'synced' | 'error'
let syncDetail = '';
let syncNotice = ''; // one-off message shown on the Settings screen
let pushTimer = null;
let applyingRemote = false;

function syncActive(){ return !!(sb && syncUser); }

// Local edits are flagged in localStorage rather than memory so that changes
// made offline (or in a tab that was closed before the push landed) are still
// known to be unpushed on the next load.
function markDirty(){
  if(applyingRemote) return; // writing pulled data back out isn't a local edit
  try{ window.localStorage.setItem(DIRTY_KEY, '1'); }catch(e){}
  if(syncActive()) schedulePush();
}
function isDirty(){
  try{ return window.localStorage.getItem(DIRTY_KEY) === '1'; }catch(e){ return false; }
}
function clearDirty(){
  try{ window.localStorage.removeItem(DIRTY_KEY); }catch(e){}
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

function applySnapshot(row){
  progress       = row.progress       || {};
  settings       = Object.assign({}, DEFAULT_SETTINGS, row.settings || {});
  mistakes       = row.mistakes       || [];
  activityDates  = row.activity_dates || [];
  reviewHistory  = row.review_history || {};
  dailyLessons   = row.daily_lessons  || { date: todayKey(), count: 0 };
  if(row.streak_saves && typeof row.streak_saves.count === 'number'){
    streakSaves = row.streak_saves;
  }
  if(dailyLessons.date !== todayKey()) dailyLessons = { date: todayKey(), count: 0 };
  // Persist locally too, so the app still works offline / signed out later.
  applyingRemote = true;
  try{
    saveProgress(); saveSettings(); saveMistakes(); saveActivity();
    saveStreakSaves(); saveReviewHistory(); saveDailyLessons();
  }finally{
    applyingRemote = false;
  }
  clearTimeout(pushTimer);
  clearDirty();
}

async function initSync(){
  if(typeof supabase === 'undefined'){
    setSyncStatus('error', 'Sync library failed to load');
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  const { data: { session } } = await sb.auth.getSession();
  if(session && session.user){
    syncUser = session.user;
    await syncNow();
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    const nextUser = session && session.user ? session.user : null;
    const changed = (nextUser && nextUser.id) !== (syncUser && syncUser.id);
    syncUser = nextUser;
    if(syncUser && changed){
      await syncNow();
      render();
    }else if(!syncUser){
      setSyncStatus('off');
    }
  });

  // Coming back to a device should pick up whatever another device wrote.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible' && syncActive()) syncNow();
  });
}

// Local unpushed edits win over the server; otherwise take the server's copy.
// Pushing on every change keeps the window where both have changed very small.
async function syncNow(){
  if(!syncActive()) return;
  setSyncStatus('syncing');
  try{
    if(isDirty()){
      await pushRemote();
    }else{
      await pullRemote();
    }
    setSyncStatus('synced');
  }catch(e){
    setSyncStatus('error', 'Sync failed, working offline');
  }
}

async function pullRemote(){
  const { data, error } = await sb
    .from('user_state').select('*').eq('user_id', syncUser.id).maybeSingle();
  if(error) throw error;
  if(!data){
    await pushRemote(); // first sign-in on this account: seed from local
    return;
  }
  const before = JSON.stringify(localSnapshot());
  const progressBefore = JSON.stringify(progress);
  applySnapshot(data);
  // An in-flight lesson, review or extra-study session was built from the
  // progress that has just been replaced, its queue and per-item results
  // describe SRS stages that no longer exist, so finishing it would write
  // decisions based on the other device's stale view. Drop it and let the
  // items fall back into the due pool. Only when progress actually moved:
  // pulls happen every time the tab regains focus, and discarding a session
  // on an identical pull would lose your place for nothing.
  if(JSON.stringify(progress) !== progressBefore){
    lessonState = null;
    reviewState = null;
    extraStudyState = null;
  }
  // Only repaint when something actually changed, so a background pull can't
  // clear an answer the user is midway through typing.
  if(JSON.stringify(localSnapshot()) !== before) render();
}

async function pushRemote(){
  const payload = Object.assign({ user_id: syncUser.id }, localSnapshot());
  let { error } = await sb.from('user_state').upsert(payload, { onConflict: 'user_id' });
  // streak_saves was added after the original schema. Until the ALTER TABLE in
  // supabase/schema.sql has been run, drop that one field and sync the rest
  // rather than letting the whole push fail.
  if(error && /streak_saves/.test(error.message || '')){
    delete payload.streak_saves;
    ({ error } = await sb.from('user_state').upsert(payload, { onConflict: 'user_id' }));
  }
  if(error) throw error;
  clearDirty();
}

function schedulePush(){
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async ()=>{
    if(!syncActive()) return;
    setSyncStatus('syncing');
    try{
      await pushRemote();
      setSyncStatus('synced');
    }catch(e){
      setSyncStatus('error', 'Sync failed, working offline');
    }
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

async function signOutSync(){
  if(!sb) return;
  await sb.auth.signOut();
  syncUser = null;
  setSyncStatus('off');
  syncNotice = 'Signed out. Progress stays on this device.';
  render();
}
