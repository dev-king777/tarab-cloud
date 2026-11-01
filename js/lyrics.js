// Lyrics from LRCLIB (free, no key). Synced (time-stamped) when available, plain otherwise.
// Results are kept in the Cache API so lyrics also show offline.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const CACHE = "tarab-lyrics-v1";
const API = "https://lrclib.net/api";
const mem = new Map(); // key -> result | Promise

const keyOf = (s) => (s.deezer_id ? "dz" + s.deezer_id : s.id);

// "Title (Official Video) [HD]" -> "Title"; also drops feat. parts
function cleanTitle(t) {
  return (t || "")
    .replace(/[([](?:[^)\]]*?(?:official|video|audio|lyrics?|paroles|clip|visuali[sz]er|hd|4k|remaster(?:ed)?|explicit|prod\.?|music)[^)\]]*?)[)\]]/gi, "")
    .replace(/\s[-–|]\s*(?:official|lyrics?|audio|video|clip).*$/i, "")
    .replace(/\s*[([]?\b(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function cleanArtist(a) {
  return (a || "").replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").split(/\s*(?:,|&| x | feat\.? | ft\.? )\s*/i)[0].trim();
}
// YouTube-style "Artist - Title" titles
function split(song) {
  let title = song.title || "", artist = song.artist || "";
  const m = title.match(/^(.+?)\s[-–]\s(.+)$/);
  if (m && (!artist || m[1].toLowerCase().includes(cleanArtist(artist).toLowerCase()) || /topic|vevo|records|music/i.test(artist))) {
    artist = m[1];
    title = m[2];
  }
  return { title: cleanTitle(title), artist: cleanArtist(artist) };
}

export function parseLRC(lrc) {
  const out = [];
  for (const line of (lrc || "").split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const t of tags) {
      const ms = t[3] ? Number(t[3].padEnd(3, "0")) : 0;
      out.push({ t: Number(t[1]) * 60 + Number(t[2]) + ms / 1000, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("lyrics " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// direct first; if the browser can't reach LRCLIB, go through our own server
async function lrclib(path) {
  try {
    return await getJSON(`${API}/${path}`);
  } catch {
    return getJSON(`${SUPABASE_URL}/functions/v1/lyrics?path=${encodeURIComponent(path)}&apikey=${SUPABASE_KEY}`, 10000);
  }
}

const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function best(list, want) {
  let pick = null, score = -1e9;
  for (const it of list || []) {
    if (it.instrumental) continue;
    if (!it.syncedLyrics && !it.plainLyrics) continue;
    let sc = 0;
    if (it.syncedLyrics) sc += 30;
    if (norm(it.trackName) === norm(want.title)) sc += 25;
    else if (norm(it.trackName).includes(norm(want.title)) || norm(want.title).includes(norm(it.trackName))) sc += 10;
    if (want.artist && norm(it.artistName).includes(norm(want.artist))) sc += 15;
    if (want.duration && it.duration) {
      const d = Math.abs(it.duration - want.duration);
      if (d > 25) sc -= 40;
      else sc -= d;
    }
    if (sc > score) { score = sc; pick = it; }
  }
  return score > -10 ? pick : null;
}

async function find(song) {
  const want = { ...split(song), duration: song.duration ? Math.round(song.duration) : 0 };
  if (!want.title) return null;
  const q = (o) => new URLSearchParams(o).toString();
  let hit = null;
  if (want.artist && want.duration) {
    hit = await lrclib(`get?${q({ track_name: want.title, artist_name: want.artist, album_name: song.album || "", duration: want.duration })}`).catch(() => null);
    if (hit && !hit.syncedLyrics && !hit.plainLyrics) hit = null;
  }
  if (!hit?.syncedLyrics) {
    const list = await lrclib(`search?${q(want.artist ? { track_name: want.title, artist_name: want.artist } : { q: want.title })}`);
    hit = best(list, want) || hit;
    if (!hit) hit = best(await lrclib(`search?${q({ q: `${want.title} ${want.artist}`.trim() })}`), want);
  }
  if (!hit) return { none: true, at: Date.now() };
  return {
    synced: hit.syncedLyrics ? parseLRC(hit.syncedLyrics) : null,
    plain: hit.plainLyrics || "",
    track: hit.trackName,
    artist: hit.artistName,
    duration: hit.duration,
  };
}

async function fromCache(key) {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(`/lyrics/${key}`);
    return r ? await r.json() : null;
  } catch {
    return null;
  }
}
async function toCache(key, val) {
  try {
    const c = await caches.open(CACHE);
    await c.put(`/lyrics/${key}`, new Response(JSON.stringify(val), { headers: { "content-type": "application/json" } }));
  } catch {}
}

// null = couldn't check (offline), {none:true} = no lyrics exist, else {synced, plain}
export function getLyrics(song, { refresh = false } = {}) {
  if (!song) return Promise.resolve(null);
  const key = keyOf(song);
  const have = mem.get(key);
  if (have && !refresh) return have instanceof Promise ? have : Promise.resolve(have);
  const p = (async () => {
    if (!refresh) {
      const c = await fromCache(key);
      // "not found" is re-checked after 3 days, lyrics get added over time
      if (c && !(c.none && Date.now() - c.at > 3 * 864e5)) return c;
    }
    if (navigator.onLine === false) return null;
    try {
      const r = await find(song);
      if (r) toCache(key, r);
      return r;
    } catch {
      return null;
    }
  })();
  mem.set(key, p);
  p.then((v) => (v ? mem.set(key, v) : mem.delete(key)));
  return p;
}

export function peekLyrics(song) {
  const v = song && mem.get(keyOf(song));
  return v && !(v instanceof Promise) ? v : null;
}

export async function clearLyrics() {
  mem.clear();
  try { await caches.delete(CACHE); } catch {}
}
