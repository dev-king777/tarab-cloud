import { createClient } from "../vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_KEY, SETUP_ENDPOINT, BUCKET } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "tarab-auth" },
});

const LS_KEY = "tarab-library-v1";
const listeners = new Set();

export const state = {
  user: null,
  songs: [], // newest first
  playlists: [],
  links: [], // playlist_songs rows
  jobs: [],
  worker: null, // { last_seen, machine }
  shareToken: null,
  settings: null, // user_settings row (cloud + discord)
};

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(what) {
  for (const fn of listeners) fn(what);
}

function saveLocal() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ songs: state.songs, playlists: state.playlists, links: state.links })
    );
  } catch {}
}
export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    state.songs = d.songs || [];
    state.playlists = d.playlists || [];
    state.links = d.links || [];
    return true;
  } catch {
    return false;
  }
}

/* ---------- auth ---------- */

export async function currentUser() {
  // don't hang on a dead connection: fall back to the saved session after 4s
  const timeout = new Promise((r) => setTimeout(() => r({ data: { session: null }, timedOut: true }), 4000));
  const res = await Promise.race([sb.auth.getSession(), timeout]).catch(() => ({ data: { session: null } }));
  state.user = res.data?.session?.user ?? storedUser();
  return state.user;
}

// The saved session, readable with no network (for opening the app offline).
export function storedUser() {
  try {
    const raw = JSON.parse(localStorage.getItem("tarab-auth") || "null");
    return raw?.user || raw?.currentSession?.user || null;
  } catch {
    return null;
  }
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyAuth(error.message));
  state.user = data.user;
  return data.user;
}

export async function createAccount(email, password) {
  const r = await fetch(SETUP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Couldn't create the account");
  return signIn(email, password);
}

export async function signOut() {
  await sb.auth.signOut();
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
  state.user = null;
}

function friendlyAuth(msg) {
  if (/invalid login/i.test(msg)) return "Wrong email or password";
  if (/network|fetch/i.test(msg)) return "No internet";
  return msg;
}

/* ---------- library ---------- */

export async function refreshAll() {
  const [s, p, l] = await Promise.all([
    sb.from("songs").select("*").order("created_at", { ascending: false }),
    sb.from("playlists").select("*").order("created_at", { ascending: true }),
    sb.from("playlist_songs").select("playlist_id,song_id,position,added_at"),
  ]);
  if (s.error) throw s.error;
  state.songs = s.data;
  state.playlists = p.data || [];
  state.links = l.data || [];
  saveLocal();
  emit("library");
}

export async function refreshJobs() {
  const { data } = await sb
    .from("jobs")
    .select("*")
    .neq("kind", "temp")
    .order("created_at", { ascending: false })
    .limit(40);
  state.jobs = data || [];
  emit("jobs");
}

export async function refreshWorker() {
  const { data } = await sb.from("worker_status").select("*").maybeSingle();
  state.worker = data || null;
  emit("worker");
}

export function workerOnline() {
  if (!state.worker) return false;
  return Date.now() - new Date(state.worker.last_seen).getTime() < 75_000;
}

export function songById(id) {
  return state.songs.find((s) => s.id === id) || virtualSongs.get(id);
}

/* ---------- online songs (streamed, not in the library) ---------- */
const VKEY = "tarab-virtual-v1";
const virtualSongs = new Map();
try {
  for (const v of JSON.parse(localStorage.getItem(VKEY) || "[]")) virtualSongs.set(v.id, v);
} catch {}
function saveVirtual() {
  try {
    localStorage.setItem(VKEY, JSON.stringify([...virtualSongs.values()].slice(-400)));
  } catch {}
}

// A catalogue track as something the player can play: your own copy if you have it, otherwise online.
export function streamSong(t) {
  const own = state.songs.find((s) => s.deezer_id === t.id);
  if (own) return own;
  const id = "dz:" + t.id;
  let v = virtualSongs.get(id);
  if (!v) {
    v = {
      id, stream: true, deezer_id: t.id, title: t.title, version: t.version || "", artist: t.artist, album: t.album,
      duration: t.duration, cover_url: t.cover_xl || t.cover, cover_small: t.cover, preview: t.preview, video_id: null,
    };
    virtualSongs.set(id, v);
    saveVirtual();
  }
  return v;
}

const resolving = new Map();
// Find the YouTube video for online songs (server caches the answers).
export async function resolveVideos(songs) {
  const need = songs.filter((s) => s?.stream && !s.video_id && !s.no_video && !resolving.has(s.id));
  if (!need.length) {
    await Promise.all(songs.map((s) => resolving.get(s?.id)).filter(Boolean));
    return;
  }
  const run = (async () => {
    for (let i = 0; i < need.length; i += 30) {
      const chunk = need.slice(i, i + 30);
      let token = SUPABASE_KEY;
      try { token = (await sb.auth.getSession()).data.session?.access_token || SUPABASE_KEY; } catch {}
      const r = await fetch(`${SUPABASE_URL}/functions/v1/yt`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: chunk.map((s) => ({ id: s.deezer_id, title: s.title, artist: s.artist, duration: s.duration })) }),
      });
      const j = await r.json().catch(() => ({}));
      for (const s of chunk) {
        const vid = j.results?.[s.deezer_id];
        if (vid) s.video_id = vid;
        else if (r.ok) s.no_video = true;
      }
    }
    saveVirtual();
  })();
  need.forEach((s) => resolving.set(s.id, run));
  try {
    await run;
  } finally {
    need.forEach((s) => resolving.delete(s.id));
  }
}

export function playlistSongs(pid) {
  return state.links
    .filter((l) => l.playlist_id === pid)
    .sort((a, b) => a.position - b.position)
    .map((l) => songById(l.song_id))
    .filter(Boolean);
}

export async function addLink(url, playlistId = null) {
  const clean = (url.match(/https?:\/\/[^\s<>"']+/) || [])[0];
  if (!clean) throw new Error("That's not a link");
  const row = { url: clean };
  if (playlistId) row.playlist_id = playlistId;
  const { error } = await sb.from("jobs").insert(row);
  if (error) throw error;
  await refreshJobs();
  nudgeCloud();
}

export async function retryJob(id) {
  await sb.from("jobs").update({ status: "pending", error: null, progress: 0 }).eq("id", id);
  await refreshJobs();
  nudgeCloud();
}

export async function deleteJob(id) {
  await sb.from("jobs").delete().eq("id", id);
  await refreshJobs();
}

export async function clearFinishedJobs() {
  await sb.from("jobs").delete().in("status", ["done", "error"]);
  await refreshJobs();
}

export async function setLiked(song, liked) {
  song.liked = liked;
  saveLocal();
  emit("library");
  const { error } = await sb.from("songs").update({ liked }).eq("id", song.id);
  if (error) {
    song.liked = !liked;
    emit("library");
    throw error;
  }
}

export async function bumpPlay(song) {
  if (!song || song.stream) return;
  song.play_count = (song.play_count || 0) + 1;
  sb.from("songs").update({ play_count: song.play_count }).eq("id", song.id).then(() => {});
}

export async function renameSong(song, title, artist) {
  const { error } = await sb.from("songs").update({ title, artist }).eq("id", song.id);
  if (error) throw error;
  song.title = title;
  song.artist = artist;
  saveLocal();
  emit("library");
}

export async function deleteSong(song) {
  const paths = [song.audio_path, song.cover_path].filter(Boolean);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  const { error } = await sb.from("songs").delete().eq("id", song.id);
  if (error) throw error;
  state.songs = state.songs.filter((s) => s.id !== song.id);
  state.links = state.links.filter((l) => l.song_id !== song.id);
  saveLocal();
  emit("library");
}

export async function createPlaylist(name) {
  const { data, error } = await sb.from("playlists").insert({ name }).select().single();
  if (error) throw error;
  state.playlists.push(data);
  saveLocal();
  emit("library");
  return data;
}

export async function renamePlaylist(pl, name) {
  const { error } = await sb.from("playlists").update({ name }).eq("id", pl.id);
  if (error) throw error;
  pl.name = name;
  saveLocal();
  emit("library");
}

export async function deletePlaylist(pl) {
  const { error } = await sb.from("playlists").delete().eq("id", pl.id);
  if (error) throw error;
  state.playlists = state.playlists.filter((p) => p.id !== pl.id);
  state.links = state.links.filter((l) => l.playlist_id !== pl.id);
  saveLocal();
  emit("library");
}

export async function addToPlaylist(pl, song) {
  if (state.links.some((l) => l.playlist_id === pl.id && l.song_id === song.id)) return false;
  const row = { playlist_id: pl.id, song_id: song.id, position: Date.now() / 1000 };
  const { error } = await sb.from("playlist_songs").insert(row);
  if (error) throw error;
  state.links.push(row);
  saveLocal();
  emit("library");
  return true;
}

export async function removeFromPlaylist(pl, song) {
  const { error } = await sb
    .from("playlist_songs")
    .delete()
    .eq("playlist_id", pl.id)
    .eq("song_id", song.id);
  if (error) throw error;
  state.links = state.links.filter((l) => !(l.playlist_id === pl.id && l.song_id === song.id));
  saveLocal();
  emit("library");
}

export async function getShareToken() {
  if (state.shareToken) return state.shareToken;
  let { data } = await sb.from("share_tokens").select("token").maybeSingle();
  if (!data) {
    const ins = await sb.from("share_tokens").insert({}).select("token").single();
    data = ins.data;
  }
  state.shareToken = data?.token ?? null;
  return state.shareToken;
}

/* ---------- storage downloads ---------- */

export async function downloadObject(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data; // Blob
}


/* ---------- quick play: online songs fetched by the PC, ad-free, not added to the library ---------- */
const TEMP_KEY = "tarab-temp-v1";
const TEMP_TTL = 30 * 3600e3; // the PC removes these files after ~36 h
const tempWaiters = new Map(); // job id -> fn(row)
const tempPending = new Map(); // deezer id -> Promise<url|null>
const tempFailed = new Map(); // deezer id -> when the PC last failed it (don't retry for a while)

function readTemp() {
  try { return JSON.parse(localStorage.getItem(TEMP_KEY) || "{}"); } catch { return {}; }
}
function writeTemp(m) {
  try {
    const now = Date.now();
    for (const k in m) if (now - m[k].at > TEMP_TTL) delete m[k];
    localStorage.setItem(TEMP_KEY, JSON.stringify(m));
  } catch {}
}
async function signedURL(path) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 6 * 3600);
  if (error || !data?.signedUrl) throw error || new Error("no url");
  return data.signedUrl;
}

function waitTemp(id, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (row) => {
      if (done) return;
      done = true;
      tempWaiters.delete(id);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(row);
    };
    tempWaiters.set(id, (row) => (row.cancelled || row.status === "done" || row.status === "error") && finish(row));
    // realtime can sleep while the phone is locked: check by hand too
    const poll = setInterval(async () => {
      const { data } = await sb.from("jobs").select("id,status,result_path,error").eq("id", id).maybeSingle();
      if (data && (data.status === "done" || data.status === "error")) finish(data);
    }, 2500);
    const timer = setTimeout(() => finish(null), ms);
  });
}

// The user moved on: drop waiting fetches for songs that are no longer current or next,
// so the PC works on what's playing now instead of songs that were skipped.
export function cancelQuickExcept(keepDeezerIds) {
  const keep = new Set(keepDeezerIds.filter(Boolean).map(String));
  for (const [k, j] of tempJobs) {
    if (keep.has(k)) continue;
    tempJobs.delete(k);
    sb.from("jobs").delete().eq("id", j.id).eq("status", "pending").then(() => {}, () => {});
    tempWaiters.get(j.id)?.({ cancelled: true });
  }
}

// true when this song can play ad-free right away (file already fetched)
export function quickReady(song) {
  const hit = song?.deezer_id && readTemp()[String(song.deezer_id)];
  return !!(hit && Date.now() - hit.at < TEMP_TTL);
}

const tempJobs = new Map(); // deezer id -> { id, prio } of the job still running

// Resolves to a playable URL, or null (PC off / too slow / failed) so the caller can fall back.
// prio: 10 = playing now, 5 = up next, 1 = prefetch from a page
export function quickAudio(song, wait = 60000, prio = 5) {
  if (!song?.deezer_id || !state.user) return Promise.resolve(null);
  const k = String(song.deezer_id);
  if (tempPending.has(k)) {
    const j = tempJobs.get(k);
    if (j && prio > j.prio) {
      j.prio = prio; // the PC does this one first now
      sb.from("jobs").update({ priority: prio }).eq("id", j.id).eq("status", "pending").then(() => {}, () => {});
    }
    return tempPending.get(k);
  }
  const p = (async () => {
    const hit = readTemp()[k];
    if (hit && Date.now() - hit.at < TEMP_TTL) {
      try { return await signedURL(hit.path); } catch {}
    }
    if (!workerOnline() || navigator.onLine === false) return null;
    if (Date.now() - (tempFailed.get(k) || 0) < 10 * 60e3) return null;
    const { data: job, error } = await sb.from("jobs").insert({
      url: song.video_id ? `https://www.youtube.com/watch?v=${song.video_id}` : `ytsearch1:${song.artist} - ${song.title}`,
      kind: "temp",
      priority: prio,
      title: `${song.title} — ${song.artist}`,
      meta: { deezer_id: song.deezer_id, title: song.title, artist: song.artist, duration: song.duration, video_id: song.video_id || null },
    }).select("id").single();
    if (error || !job) return null;
    tempJobs.set(k, { id: job.id, prio });
    const row = await waitTemp(job.id, wait);
    tempJobs.delete(k);
    if (row?.cancelled) return null;
    if (!row || row.status !== "done" || !row.result_path) {
      if (!row) sb.from("jobs").delete().eq("id", job.id).then(() => {}, () => {});
      tempFailed.set(k, Date.now());
      return null;
    }
    const m = readTemp();
    m[k] = { path: row.result_path, at: Date.now() };
    writeTemp(m);
    return signedURL(row.result_path).catch(() => null);
  })();
  tempPending.set(k, p);
  p.then((u) => (u ? setTimeout(() => tempPending.delete(k), 5 * 3600e3) : tempPending.delete(k)), () => tempPending.delete(k));
  return p;
}

/* ---------- realtime ---------- */

let channel = null;
let reloadTimer = null;
export function startRealtime() {
  if (channel || !state.user) return;
  const uid = state.user.id;
  channel = sb
    .channel("tarab-" + uid)
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `user_id=eq.${uid}` }, (p) => {
      const row = p.new && p.new.id ? p.new : null;
      if (row?.kind === "temp") {
        tempWaiters.get(row.id)?.(row);
        return;
      }
      if (p.eventType === "DELETE") {
        state.jobs = state.jobs.filter((j) => j.id !== p.old.id);
      } else if (row) {
        const i = state.jobs.findIndex((j) => j.id === row.id);
        if (i >= 0) state.jobs[i] = row;
        else state.jobs.unshift(row);
      }
      emit("jobs");
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "songs", filter: `user_id=eq.${uid}` }, (p) => {
      if (p.eventType === "INSERT") emit({ type: "song-added", song: p.new });
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => refreshAll().catch(() => {}), 600);
    })
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "worker_status", filter: `user_id=eq.${uid}` },
      (p) => {
        if (p.new && p.new.user_id) state.worker = p.new;
        emit("worker");
      }
    )
    .subscribe();
}

/* ---------- music catalogue (Deezer via the "music" function) ---------- */
const catCache = new Map();
export async function catalog(params) {
  const qs = new URLSearchParams(params).toString();
  const hit = catCache.get(qs);
  if (hit && Date.now() - hit.t < 8 * 60 * 1000) return hit.v;
  let token = SUPABASE_KEY;
  try {
    token = (await sb.auth.getSession()).data.session?.access_token || SUPABASE_KEY;
  } catch {}
  const r = await fetch(`${SUPABASE_URL}/functions/v1/music?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Search failed");
  catCache.set(qs, { t: Date.now(), v: j });
  return j;
}

// "have" = already in the library, "queued" = waiting/downloading, null = not added
export function catalogStatus(deezerId) {
  if (!deezerId) return null;
  if (state.songs.some((s) => s.deezer_id === deezerId)) return "have";
  if (state.jobs.some((j) => j.meta?.deezer_id === deezerId && (j.status === "pending" || j.status === "working"))) return "queued";
  return null;
}

export function songForDeezer(deezerId) {
  return state.songs.find((s) => s.deezer_id === deezerId) || null;
}

export async function addCatalogTracks(tracks, playlist = null) {
  const rows = [];
  let had = 0;
  for (const t of tracks) {
    const st = catalogStatus(t.id);
    if (st === "have") {
      had++;
      if (playlist) await addToPlaylist(playlist, songForDeezer(t.id)).catch(() => {});
      continue;
    }
    if (st === "queued") continue;
    const version = t.version && !/remaster/i.test(t.version) ? ` ${t.version}` : "";
    rows.push({
      url: `ytsearch5:${t.artist} - ${t.title}${version}`,
      title: `${t.title} — ${t.artist}`,
      playlist_id: playlist?.id ?? null,
      meta: {
        deezer_id: t.id,
        title: t.title,
        version: t.version || "",
        artist: t.artist,
        album: t.album,
        cover: t.cover_xl || t.cover,
        duration: t.duration,
      },
    });
  }
  if (rows.length) {
    const { error } = await sb.from("jobs").insert(rows);
    if (error) throw error;
    await refreshJobs();
    nudgeCloud();
  }
  return { queued: rows.length, had };
}

/* ---------- your own files ---------- */
const AUDIO_TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", mp4: "audio/mp4" };

function readDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    a.src = url;
  });
}

// Upload an audio file picked on the phone straight into the library.
export async function uploadSongFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = AUDIO_TYPES[ext] || file.type;
  if (!type || !type.startsWith("audio")) throw new Error(`${file.name}: unsupported format`);
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name}: too big (max 50 MB)`);
  const stem = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  let title = stem, artist = null;
  const m = stem.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  const id = crypto.randomUUID();
  const path = `${state.user.id}/${id}.${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: true });
  if (upErr) throw upErr;
  const duration = await readDuration(file);
  const row = { id, title, artist, duration, audio_path: path, ext, size_bytes: file.size };
  const { data, error } = await sb.from("songs").insert(row).select().single();
  if (error) {
    await sb.storage.from(BUCKET).remove([path]);
    throw error;
  }
  state.songs.unshift(data);
  saveLocal();
  emit("library");
  return data;
}

// A failed song: try again from a link the user found, keeping its title and cover.
export async function retryWithLink(job, url) {
  const clean = (url.match(/https?:\/\/[^\s<>"']+/) || [])[0];
  if (!clean) throw new Error("That's not a link");
  const { error } = await sb.from("jobs").insert({ url: clean, title: job.title, meta: job.meta, playlist_id: job.playlist_id });
  if (error) throw error;
  await sb.from("jobs").delete().eq("id", job.id);
  await refreshJobs();
  nudgeCloud();
}

/* ---------- cloud downloads + Discord settings ---------- */
export async function loadUserSettings() {
  const { data } = await sb.from("user_settings").select("github_repo,cloud_enabled,last_dispatch,cloud_seen,discord_app_id,discord_enabled,github_token").maybeSingle();
  state.settings = data ? { ...data, has_token: !!data.github_token, github_token: undefined } : null;
  emit("settings");
  return state.settings;
}

export async function saveUserSettings(patch) {
  const { error } = await sb.from("user_settings").upsert({ user_id: state.user.id, ...patch, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadUserSettings();
}

export async function kickCloud(force = false) {
  const token = (await sb.auth.getSession()).data.session?.access_token;
  if (!token) return { status: "no_session" };
  const r = await fetch(`${SUPABASE_URL}/functions/v1/kick`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  return r.json().catch(() => ({ status: "error", error: `HTTP ${r.status}` }));
}

// When the PC is off, ask the cloud to take over (no-op if not set up).
export function nudgeCloud() {
  // the cloud downloader was removed: downloads run on the PC only
}

export async function publishNowPlaying(row) {
  const { error } = await sb.from("now_playing").upsert({ user_id: state.user.id, ...row });
  if (error) throw error;
}
