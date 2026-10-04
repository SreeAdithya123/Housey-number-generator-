// Everything the app says to Supabase lives here: sign in, the user's role,
// the public game state players watch, and the admin-only state. Which rows a
// visitor may read or write is decided by the database (see
// supabase/migrations), not by this file.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const POLL_MS = 15_000;
const PUBLIC_COLUMNS = 'status, called, current_number, wins, updated_at';

let client = null;

function getClient() {
  if (client) return client;
  if (!window.supabase?.createClient) throw new Error('The live service could not be loaded.');
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

function friendly(error) {
  const text = String(error?.message || error || '');
  if (/invalid login credentials/i.test(text)) return new Error('Wrong email or password.');
  if (/email not confirmed/i.test(text)) return new Error('Confirm your email first (check your inbox), then sign in.');
  if (/already registered/i.test(text)) return new Error('That email already has an account. Sign in instead.');
  if (/failed to fetch|networkerror|load failed/i.test(text)) return new Error("Can't reach the server. Check your connection.");
  return new Error(text || 'Something went wrong.');
}

export async function getSession() {
  const { data, error } = await getClient().auth.getSession();
  if (error) throw friendly(error);
  return data.session;
}

export async function accessToken() {
  return (await getSession())?.access_token || null;
}

export async function signIn(email, password) {
  const { error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw friendly(error);
}

/** Creates a player account. Resolves to { needsConfirmation } (true when an email must be confirmed first). */
export async function signUp(email, password) {
  const { data, error } = await getClient().auth.signUp({ email, password });
  if (error) throw friendly(error);
  return { needsConfirmation: !data.session };
}

export async function signOut() {
  await getClient().auth.signOut();
}

/** 'admin' or 'player'. The database is the source of truth; the UI only reflects it. */
export async function fetchRole(userId) {
  const { data, error } = await getClient().from('profiles').select('role').eq('id', userId).maybeSingle();
  if (error) throw friendly(error);
  return data?.role === 'admin' ? 'admin' : 'player';
}

export async function loadPublic() {
  const { data, error } = await getClient().from('game_public').select(PUBLIC_COLUMNS).eq('id', 1).maybeSingle();
  if (error) throw friendly(error);
  return data;
}

export async function loadAdmin() {
  const { data, error } = await getClient().from('game_admin').select('tickets, rigs, decoy_count').eq('id', 1).maybeSingle();
  if (error) throw friendly(error);
  return data;
}

// A row level security block on an update is silent (zero rows changed), so
// ask for the changed row back and treat "nothing changed" as a failure.
async function writeRow(table, payload) {
  const { data, error } = await getClient().from(table).update(payload).eq('id', 1).select('id');
  if (error) throw friendly(error);
  if (!data?.length) throw new Error('The server refused the update. Are you signed in as admin?');
}

export const publishPublic = (payload) => writeRow('game_public', payload);
export const saveAdmin = (payload) => writeRow('game_admin', payload);

/** Draws the next number for the shared game. Resolves to { ok, reason?, number? }. */
export async function callNextNumber() {
  const { data, error } = await getClient().rpc('call_next_number');
  if (error) throw friendly(error);
  return data;
}

/**
 * Calls onRow(row) whenever the public game state changes (live), plus on
 * reconnect, when the tab becomes visible again and every 15 seconds as a
 * safety net. onStatus(true|false) reports whether the connection is healthy.
 * Returns a function that stops watching.
 */
export function watchPublic(onRow, onStatus) {
  const c = getClient();
  let stopped = false;

  const refresh = async () => {
    try {
      const row = await loadPublic();
      if (stopped) return;
      if (row) onRow(row);
      onStatus(true);
    } catch {
      if (!stopped) onStatus(false);
    }
  };

  const channel = c
    .channel('game-public')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_public' }, (payload) => {
      if (stopped || !payload.new) return;
      onRow(payload.new);
      onStatus(true);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') refresh();
      else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status) && !stopped) onStatus(false);
    });

  const timer = setInterval(refresh, POLL_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    c.removeChannel(channel);
  };
}
