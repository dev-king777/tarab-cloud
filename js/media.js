// Offline copies of audio + covers live in the Cache API, keyed by song id.
import { downloadObject, songById } from "./data.js";

const AUDIO_CACHE = "tarab-audio-v1";
const COVER_CACHE = "tarab-covers-v1";
const coverURLs = new Map(); // song id -> object URL
const coverPending = new Map();
const colorMemo = new Map();
const audioPending = new Map();
const offlineSet = new Set();

const key = (kind, id) => new Request(`/__offline/${kind}/${id}`);

async function openCache(name) {
  if (!("caches" in self)) return null;
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

export async function scanOffline() {
  const c = await openCache(AUDIO_CACHE);
  offlineSet.clear();
  if (!c) return offlineSet;
  for (const req of await c.keys()) {
    const id = new URL(req.url).pathname.split("/").pop();
    offlineSet.add(id);
  }
  return offlineSet;
}

export const isOffline = (id) => offlineSet.has(id);

/* ---------- audio ---------- */

export async function getAudioBlob(song, onProgress) {
  const c = await openCache(AUDIO_CACHE);
  if (c) {
    const hit = await c.match(key("a", song.id));
    if (hit) return hit.blob();
  }
  if (audioPending.has(song.id)) return audioPending.get(song.id);
  const p = (async () => {
    onProgress?.(0);
    const blob = await downloadObject(song.audio_path);
    const type = song.ext === "mp3" ? "audio/mpeg" : "audio/mp4";
    const typed = blob.type && blob.type !== "application/octet-stream" ? blob : new Blob([blob], { type });
    if (c) {
      try {
        await c.put(key("a", song.id), new Response(typed, { headers: { "Content-Type": typed.type } }));
        offlineSet.add(song.id);
      } catch {}
    }
    onProgress?.(1);
    return typed;
  })();
  audioPending.set(song.id, p);
  try {
    return await p;
  } finally {
    audioPending.delete(song.id);
  }
}

/* ---------- keep the whole library on the phone ---------- */
let syncing = false;
let syncAgain = false;
export const syncState = { running: false, done: 0, total: 0, failed: 0 };

// Downloads every song (audio + cover) that isn't on the phone yet.
// Safe to call often: one run at a time, a second call just schedules another pass.
export async function syncOffline(songs, onStatus) {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const todo = songs().filter((s) => !offlineSet.has(s.id) && s.audio_path);
      syncState.running = todo.length > 0;
      syncState.total = todo.length;
      syncState.done = 0;
      syncState.failed = 0;
      onStatus?.(syncState);
      let i = 0;
      const lane = async () => {
        while (i < todo.length) {
          if (navigator.onLine === false) return;
          const s = todo[i++];
          try {
            await getAudioBlob(s);
            if (s.cover_path) await getCoverURL(s);
            syncState.done++;
          } catch {
            syncState.failed++;
          }
          onStatus?.(syncState);
        }
      };
      await Promise.all([lane(), lane()]);
      syncState.running = false;
      onStatus?.(syncState);
    } while (syncAgain);
  } finally {
    syncing = false;
    syncState.running = false;
  }
}

// Remove phone copies of songs that were deleted from the library.
export async function pruneOffline(validIds) {
  const keep = new Set(validIds);
  for (const id of [...offlineSet]) if (!keep.has(id)) await removeOffline(id);
}

// Store a file we already have in memory (e.g. just uploaded from the phone).
export async function putAudio(id, blob) {
  const c = await openCache(AUDIO_CACHE);
  if (!c) return;
  try {
    await c.put(key("a", id), new Response(blob, { headers: { "Content-Type": blob.type || "audio/mpeg" } }));
    offlineSet.add(id);
  } catch {}
}

export async function removeOffline(id) {
  const c = await openCache(AUDIO_CACHE);
  if (c) await c.delete(key("a", id));
  const cc = await openCache(COVER_CACHE);
  if (cc) await cc.delete(key("c", id));
  offlineSet.delete(id);
  const u = coverURLs.get(id);
  if (u) URL.revokeObjectURL(u);
  coverURLs.delete(id);
}

export async function clearAllAudio() {
  if ("caches" in self) await caches.delete(AUDIO_CACHE);
  offlineSet.clear();
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    return e;
  } catch {
    return null;
  }
}

export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

/* ---------- covers ---------- */

// Small concurrency gate so a big library doesn't fire 300 requests at once.
let active = 0;
const waiting = [];
async function gate(fn) {
  if (active >= 4) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function coverURLSync(id) {
  if (coverURLs.has(id)) return coverURLs.get(id);
  const s = songById(id);
  return s && !s.cover_path ? s.cover_url || null : null;
}

export async function getCoverURL(song) {
  if (!song?.cover_path) return song?.cover_url || null;
  if (coverURLs.has(song.id)) return coverURLs.get(song.id);
  if (coverPending.has(song.id)) return coverPending.get(song.id);
  const p = gate(async () => {
    const c = await openCache(COVER_CACHE);
    let blob = null;
    if (c) {
      const hit = await c.match(key("c", song.id));
      if (hit) blob = await hit.blob();
    }
    if (!blob) {
      blob = await downloadObject(song.cover_path);
      if (c) {
        try {
          await c.put(key("c", song.id), new Response(blob, { headers: { "Content-Type": "image/jpeg" } }));
        } catch {}
      }
    }
    const url = URL.createObjectURL(blob);
    coverURLs.set(song.id, url);
    return url;
  }).catch(() => null);
  coverPending.set(song.id, p);
  try {
    return await p;
  } finally {
    coverPending.delete(song.id);
  }
}

// Paint any <img data-cover="id"> once its cover is ready.
export function hydrateCovers(root, lookup) {
  root.querySelectorAll("img[data-cover]").forEach((img) => {
    const id = img.dataset.cover;
    const ready = coverURLs.get(id);
    if (ready) {
      img.src = ready;
      img.classList.add("in");
      return;
    }
    const song = lookup(id);
    if (!song) return;
    getCoverURL(song).then((u) => {
      if (u && img.dataset.cover === id) {
        img.src = u;
        img.classList.add("in");
      }
    });
  });
}

/* ---------- color from artwork ---------- */

export async function coverColors(song) {
  if (colorMemo.has(song.id)) return colorMemo.get(song.id);
  const fallback = seedColors(song.id);
  const url = await getCoverURL(song);
  if (!url) return fallback;
  try {
    const img = await loadImg(url);
    const cv = document.createElement("canvas");
    cv.width = cv.height = 24;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0, 24, 24);
    const px = cx.getImageData(0, 0, 24, 24).data;
    const buckets = [];
    for (let i = 0; i < px.length; i += 4) {
      const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      buckets.push({ h, s, l, score: s * (1 - Math.abs(l - 0.5) * 1.6) });
    }
    buckets.sort((a, b) => b.score - a.score);
    const vivid = buckets[0];
    // a second hue that is meaningfully different from the first
    const second = buckets.find((b) => hueDist(b.h, vivid.h) > 40 && b.s > 0.15) || {
      h: (vivid.h + 35) % 360,
      s: vivid.s,
      l: vivid.l,
    };
    const res = {
      a: hsl(vivid.h, clamp(vivid.s, 0.35, 0.85), 0.42),
      b: hsl(second.h, clamp(second.s, 0.3, 0.8), 0.3),
      deep: hsl(vivid.h, clamp(vivid.s * 0.7, 0.25, 0.6), 0.11),
    };
    colorMemo.set(song.id, res);
    return res;
  } catch {
    return fallback;
  }
}

function seedColors(id) {
  let n = 0;
  for (const ch of id || "x") n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const h = n % 360;
  return { a: hsl(h, 0.55, 0.42), b: hsl((h + 50) % 360, 0.5, 0.3), deep: hsl(h, 0.4, 0.11) };
}

const loadImg = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    if (/^https?:/.test(src)) i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
