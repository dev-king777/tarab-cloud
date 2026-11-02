import {
  state, onChange, loadLocal, currentUser, signIn, createAccount, signOut, refreshAll, refreshJobs,
  refreshWorker, workerOnline, songById, playlistSongs, addLink, retryJob, deleteJob, clearFinishedJobs,
  setLiked, renameSong, deleteSong, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist,
  removeFromPlaylist, getShareToken, startRealtime, catalog, catalogStatus, songForDeezer, addCatalogTracks,
  uploadSongFile, retryWithLink, loadUserSettings, saveUserSettings, kickCloud, nudgeCloud, publishNowPlaying,
  streamSong, resolveVideos, quickAudio, quickReady, cancelQuickExcept, quickPart,
} from "./data.js";
import {
  hydrateCovers, coverURLSync, getCoverURL, coverColors, scanOffline, isOffline, getAudioBlob,
  removeOffline, clearAllAudio, storageEstimate, requestPersist, syncOffline, pruneOffline, syncState, putAudio,
} from "./media.js";
import { player } from "./player.js";
import { getLyrics } from "./lyrics.js";
import { SHARE_ENDPOINT, APP_VERSION } from "./config.js";

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const totalTime = (songs) => {
  const m = Math.round(songs.reduce((a, s) => a + (s.duration || 0), 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
};
const plural = (n) => `${n} ${n === 1 ? "song" : "songs"}`;
const setImg = (img, url) => (url ? (img.src = url) : img.removeAttribute("src"));
const art = (song, cls = "") =>
  `<span class="art ${cls}">${icon("note")}${song?.cover_path ? `<img data-cover="${song.id}" alt="">` : song?.cover_url ? `<img class="in" src="${esc(song.cover_url)}" alt="" loading="lazy">` : ""}</span>`;
const CARD_COLORS = ["mint", "rose", "", "sun"];
const isDesktop = () => matchMedia("(min-width: 900px)").matches;
// downloads happen on the PC only
const cloudReady = () => false;
const cloudInstant = () => false;

let toastTimer;
function toast(msg, warn = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("warn", warn);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}
const haptic = () => { try { navigator.vibrate?.(8); } catch {} };

function displayName() {
  try {
    const saved = localStorage.getItem("tarab-name");
    if (saved) return saved;
  } catch {}
  const base = (state.user?.email || "").split("@")[0].replace(/[^a-zA-Z]+.*$/, "") || "Sahbi";
  return base.charAt(0).toUpperCase() + base.slice(1);
}
function avatarSrc() {
  try {
    return localStorage.getItem("tarab-avatar") || "icons/avatar.jpg";
  } catch {
    return "icons/avatar.jpg";
  }
}
const avatarImg = () => `<img src="${esc(avatarSrc())}" alt="">`;

// Pick a photo, crop it to a centered square, keep it on this phone.
function filePicker(accept, multiple, onPick) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.style.cssText = "position:fixed;left:-999px;opacity:0";
  document.body.appendChild(input);
  input.onchange = () => {
    const files = [...(input.files || [])];
    input.remove();
    if (files.length) onPick(files);
  };
  input.click();
}

function pickAvatar() {
  filePicker("image/*", false, ([f]) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      try {
        localStorage.setItem("tarab-avatar", c.toDataURL("image/jpeg", 0.85));
      } catch {
        return toast("Couldn't save the picture", true);
      }
      refreshAvatars();
      toast("Picture updated");
    };
    img.onerror = () => toast("Couldn't read this picture", true);
    img.src = url;
  });
}

// Audio files from the phone (Fichiers, Telegram/WhatsApp saved to Files…)
function pickUpload() {
  if (navigator.onLine === false) return toast("You need internet to upload a file", true);
  filePicker("audio/*,.mp3,.m4a,.aac,.wav,.flac", true, async (files) => {
    let ok = 0;
    for (const [i, f] of files.entries()) {
      toast(files.length > 1 ? `Uploading ${i + 1}/${files.length}…` : "Uploading…");
      try {
        const song = await uploadSongFile(f);
        await putAudio(song.id, f);
        ok++;
      } catch (e) {
        toast(e.message || `${f.name} didn't upload`, true);
        await new Promise((r) => setTimeout(r, 1800));
      }
    }
    if (ok) {
      haptic();
      toast(ok === 1 ? "Added ✓ and saved on this phone" : `${ok} songs added ✓`);
    }
    refreshLists();
  });
}
function refreshAvatars() {
  document.querySelectorAll(".avatar").forEach((a) => (a.innerHTML = avatarImg()));
  renderSidebar();
}
async function profileMenu() {
  const v = await actionSheet(
    `<div class="sheet-head"><span class="avatar" style="width:50px;height:50px">${avatarImg()}</span><div><b>${esc(displayName())}</b><small>${esc(state.user?.email || "")}</small></div></div>`,
    [
      { id: "photo", label: "Change picture", icon: "pencil" },
      { id: "name", label: "Rename", icon: "pencil" },
      { id: "reset", label: "Reset picture", icon: "retry" },
      { id: "out", label: "Sign out", icon: "logout", danger: true },
    ]
  );
  if (v === "out") return doSignOut();
  if (v === "photo") pickAvatar();
  if (v === "reset") {
    try { localStorage.removeItem("tarab-avatar"); } catch {}
    refreshAvatars();
  }
  if (v === "name") {
    const n = await promptSheet("What's your name?", displayName(), "Save");
    if (n) {
      try { localStorage.setItem("tarab-name", n); } catch {}
      renderHomeShell();
      if (currentTab === "settings") renderSettings();
    }
  }
}

async function doSignOut() {
  if (!(await actionSheet(`<div class="sheet-head"><div><b>Sign out of Tarab?</b><small>${esc(state.user?.email || "")} · music saved on this device stays</small></div></div>`,
    [{ id: "ok", label: "Sign out", icon: "logout", danger: true }]).then((v) => v === "ok"))) return;
  try { player.pause?.(); player.cur.pause(); player.yt.pause(); } catch {}
  try { await signOut(); } catch {}
  location.reload();
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 22) return "Good evening";
  return "Good night";
}

/* ---------- bottom sheets ---------- */
function openSheet(html, onClick) {
  const sheet = $("#sheet"), ov = $("#overlay");
  sheet.innerHTML = html;
  sheet.hidden = ov.hidden = false;
  hydrateCovers(sheet, songById);
  const close = () => {
    sheet.hidden = ov.hidden = true;
    sheet.innerHTML = "";
    ov.onclick = null;
    sheet.onclick = null;
  };
  ov.onclick = close;
  sheet.onclick = (e) => {
    const b = e.target.closest("[data-sheet]");
    if (!b) return;
    const v = b.dataset.sheet;
    if (v === "cancel") return close();
    if (onClick?.(v, b, close) !== true) close();
  };
  return close;
}

function actionSheet(head, items) {
  return new Promise((resolve) => {
    const rows = items
      .map((it) => `<button class="sheet-btn ${it.danger ? "danger" : ""}" data-sheet="${it.id}"><span class="ico">${icon(it.icon)}</span>${esc(it.label)}</button>`)
      .join("");
    openSheet(`<div class="sheet-card">${head || ""}${rows}</div><button class="sheet-cancel" data-sheet="cancel">Cancel</button>`, (v) => resolve(v));
    $("#overlay").addEventListener("click", () => resolve(null), { once: true });
    $(".sheet-cancel").addEventListener("click", () => resolve(null), { once: true });
  });
}

function promptSheet(title, value = "", ok = "Save", placeholder = "") {
  return new Promise((resolve) => {
    const close = openSheet(
      `<form class="sheet-card sheet-form" id="pf"><h3>${esc(title)}</h3>
        <input class="input" id="pf-in" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done">
        <div class="btns"><button type="button" class="btn btn-dark" data-sheet="cancel">Cancel</button><button class="btn btn-lav" type="submit">${esc(ok)}</button></div></form>`
    );
    const input = $("#pf-in");
    setTimeout(() => input.focus(), 50);
    $("#pf").onsubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      close();
      resolve(v || null);
    };
    $("#overlay").addEventListener("click", () => resolve(null), { once: true });
  });
}

const confirmSheet = (title, okLabel) =>
  actionSheet(`<div class="sheet-head"><div><b>${esc(title)}</b></div></div>`, [{ id: "ok", label: okLabel, icon: "trash", danger: true }]).then((v) => v === "ok");

/* ================= navigation ================= */
let currentTab = "songs";
const listCtx = new Map(); // list key -> song ids that "play" means for that list

function showTab(name) {
  if (name === currentTab) {
    const views = $(`#tab-${name}`).querySelectorAll(".view");
    if (views.length > 1) popView(name);
    else views[0]?.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  currentTab = name;
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.dataset.tab !== name));
  document.querySelectorAll("#tabbar button, .sb-nav button").forEach((b) => b.classList.toggle("on", b.dataset.go === name));
  if (name === "add") renderAdd();
  if (name === "search") renderSearch();
  if (name === "settings") renderSettings();
}

function pushView(tabName, onMount) {
  const tab = $(`#tab-${tabName}`);
  const under = tab.lastElementChild;
  const v = document.createElement("div");
  v.className = "view pushed-in";
  tab.appendChild(v);
  onMount?.(v);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      v.classList.remove("pushed-in");
      under?.classList.add("pushed-under");
    })
  );
  return v;
}

function popView(tabName) {
  const views = $(`#tab-${tabName}`).querySelectorAll(".view");
  if (views.length < 2) return;
  const top = views[views.length - 1], under = views[views.length - 2];
  top.classList.add("pushed-in");
  under.classList.remove("pushed-under");
  setTimeout(() => top.remove(), 420);
}

/* ================= rows ================= */
function songRow(s, ctx) {
  const cur = player.song?.id === s.id;
  const playing = cur && player.playing;
  return `<li class="row ${cur ? "current" : ""} ${playing ? "playing" : ""}" data-song="${s.id}" data-ctx="${ctx}">
    ${art(s)}
    <span class="row-text"><span class="row-title">${esc(s.title)}</span>
      <span class="row-sub">${s.liked ? icon("heart-fill", "liked") : ""}<span class="a">${esc(s.artist || "Unknown artist")}</span>${s.duration ? `<i class="sep"></i><span class="t">${fmt(s.duration)}</span>` : ""}${isOffline(s.id) ? "" : icon("cloud-down", "cloud")}</span></span>
    <button class="more" data-more="${s.id}" data-ctx="${ctx}" aria-label="More">${icon("more")}</button>
    <button class="rbtn" data-rplay="${s.id}" data-ctx="${ctx}" aria-label="Play">${playing ? `<span class="eq"><i></i><i></i><i></i></span>` : icon("play")}</button>
  </li>`;
}

function markRows() {
  const dz = String(player.song?.deezer_id || "");
  document.querySelectorAll(".crow").forEach((r) => {
    const cur = !!dz && r.dataset.ctrack === dz;
    const playing = cur && player.playing;
    r.classList.toggle("current", cur);
    if (playing !== r.classList.contains("playing")) {
      r.classList.toggle("playing", playing);
      const pvEl = r.querySelector(".pv");
      if (pvEl) pvEl.innerHTML = playing ? `<span class="eq"><i></i><i></i><i></i></span>` : icon("play");
    }
  });
  document.querySelectorAll(".row[data-song]").forEach((r) => {
    const cur = r.dataset.song === player.song?.id;
    const playing = cur && player.playing;
    r.classList.toggle("current", cur);
    if (playing !== r.classList.contains("playing")) {
      r.classList.toggle("playing", playing);
      const b = r.querySelector(".rbtn");
      if (b) b.innerHTML = playing ? `<span class="eq"><i></i><i></i><i></i></span>` : icon("play");
    }
  });
}

function cardStack(songs) {
  const withArt = songs.filter((s) => s.cover_path).slice(0, 3);
  return withArt.length ? `<span class="card-stack">${withArt.map((s) => art(s)).join("")}</span>` : "";
}

/* ================= home ================= */
let filter = "all";
let query = "";

function renderHomeShell() {
  const tab = $("#tab-songs");
  tab.innerHTML = `<div class="view" id="home-view">
    <div class="topbar">
      <button class="avatar" data-profile aria-label="Profile">${avatarImg()}</button>
      <span class="grow greet"><small>${greeting()}</small><b id="hello-name">${esc(displayName())}</b></span>
      <span class="actions">
        <button class="round" data-search aria-label="Search">${icon("search")}</button>
        <button class="round" data-openpl="liked" aria-label="Liked">${icon("heart")}</button>
      </span>
    </div>
    <label class="searchbar" id="searchbar" hidden>${icon("search")}<input id="q" type="search" placeholder="Search your music" autocomplete="off" enterkeyhint="search"><button type="button" data-search-close aria-label="Close">${icon("x")}</button></label>
    <h1 class="hero-title" id="hero">Your music,<br>anytime.</h1>
    <p class="sync-line" id="sync-line"></p>
    <div class="chips" id="chips">
      <button class="chip on" data-f="all">All</button>
      <button class="chip" data-f="new">New</button>
      <button class="chip" data-f="liked">Liked</button>
      <button class="chip" data-f="top">Most played</button>
      <button class="chip" data-f="offline">On phone</button>
    </div>
    <div id="home-body"></div>
  </div>`;
  $("#q").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    renderHomeBody();
  });
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    filter = b.dataset.f;
    $("#chips").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
    renderHomeBody();
  });
  renderHomeBody();
  renderSync();
}

function filteredSongs() {
  let list = state.songs;
  if (filter === "new") list = list.slice(0, 25);
  if (filter === "liked") list = list.filter((s) => s.liked);
  if (filter === "offline") list = list.filter((s) => isOffline(s.id));
  if (filter === "top") list = list.filter((s) => s.play_count > 0).sort((a, b) => b.play_count - a.play_count).slice(0, 50);
  if (query) list = list.filter((s) => (s.title + " " + (s.artist || "")).toLowerCase().includes(query));
  return list;
}

function renderHomeBody() {
  const body = $("#home-body");
  if (!body) return;
  if (!state.songs.length) {
    body.innerHTML = `<div class="empty"><h3>No songs yet</h3>
      <p>Copy a link from YouTube and paste it in "Add". Your PC downloads it and it lands here, saved on your phone.</p>
      <button class="btn btn-lav" data-go="add">${icon("plus")}Add your first link</button></div>`;
    return;
  }
  const list = filteredSongs();
  listCtx.set("lib", list.map((s) => s.id));
  listCtx.set("all", state.songs.map((s) => s.id));
  const liked = state.songs.filter((s) => s.liked);
  listCtx.set("pl:liked", liked.map((s) => s.id));

  let cards = "";
  if (filter === "all" && !query) {
    const shuffledPreview = state.songs.slice().sort(() => 0.5 - Math.random());
    cards = `<div class="section-h"><h2>Mixes</h2></div><div class="cards">
      <div class="card" data-card="all">
        ${cardStack(shuffledPreview)}
        <h3>Today's mix</h3><p>Everything shuffled · ${plural(state.songs.length)}</p>
        <div class="card-row"><button class="card-play" data-shuffleall="all" aria-label="Play">${icon("play")}</button>
        <button class="card-ico" data-shuffleall="all" aria-label="Shuffle">${icon("shuffle")}</button></div>
      </div>
      ${liked.length ? `<div class="card sun" data-openpl="liked">
        ${cardStack(liked)}
        <h3>Liked</h3><p>${plural(liked.length)} you love</p>
        <div class="card-row"><button class="card-play" data-playall="pl:liked" aria-label="Play">${icon("play")}</button>
        <button class="card-ico" data-shuffleall="pl:liked" aria-label="Shuffle">${icon("shuffle")}</button></div>
      </div>` : ""}
      ${state.playlists
        .map((p, i) => {
          const songs = playlistSongs(p.id);
          listCtx.set("pl:" + p.id, songs.map((s) => s.id));
          return `<div class="card ${CARD_COLORS[i % CARD_COLORS.length]}" data-openpl="${p.id}">
            ${cardStack(songs)}
            <h3>${esc(p.name)}</h3><p>${plural(songs.length)}${songs.length ? " · " + totalTime(songs) : ""}</p>
            <div class="card-row">${songs.length ? `<button class="card-play" data-playall="pl:${p.id}" aria-label="Play">${icon("play")}</button>
            <button class="card-ico" data-shuffleall="pl:${p.id}" aria-label="Shuffle">${icon("shuffle")}</button>` : ""}
            <button class="card-ico" data-plmore="${p.id}" aria-label="More">${icon("more")}</button></div>
          </div>`;
        })
        .join("")}
    </div>`;
  }

  const label = { all: "All songs", new: "New", liked: "Liked", top: "Most played", offline: "On phone" }[filter];
  const emptyMsg =
    filter === "liked" ? "No likes yet. Tap the heart in the player." :
    filter === "top" ? "Listen a bit and your most played songs show up here." :
    filter === "offline" ? "Music saves itself to the phone whenever you have internet." : "Nothing found.";
  body.innerHTML = `${cards}
    <div class="section-h"><h2>${query ? "Results" : label}</h2>${list.length > 1 ? `<button data-shuffleall="lib">Shuffle</button>` : ""}</div>
    ${list.length ? `<ul class="list">${list.map((s) => songRow(s, "lib")).join("")}</ul>` : `<div class="empty"><p>${emptyMsg}</p></div>`}`;
  hydrateCovers(body, songById);
}

function renderSync() {
  const el = $("#sync-line");
  if (!el) return;
  const total = state.songs.length;
  const off = state.songs.filter((s) => isOffline(s.id)).length;
  let cls = "", text;
  if (!total) text = "Nothing here yet";
  else if (navigator.onLine === false) { cls = "off"; text = `Offline · ${off} saved on this phone`; }
  else if (syncState.running) { cls = "busy"; text = `Saving to phone… ${off}/${total}`; }
  else if (!player.settings.autoOffline && off < total) { cls = "off"; text = `${off}/${total} on phone`; }
  else if (off >= total) text = `${plural(total)} · all on this phone`;
  else { cls = "off"; text = `${off}/${total} on phone`; }
  el.className = "sync-line " + cls;
  el.innerHTML = `<span class="dot"></span>${esc(text)}`;
}

/* ================= playlists ================= */
function renderPlaylists() {
  const tab = $("#tab-playlists");
  let root = tab.querySelector(".view");
  if (!root) {
    root = document.createElement("div");
    root.className = "view";
    tab.appendChild(root);
  }
  const liked = state.songs.filter((s) => s.liked);
  listCtx.set("pl:liked", liked.map((s) => s.id));
  root.innerHTML = `<div class="topbar"><h1 class="page-title" style="margin:8px 0 0;flex:1">Playlists</h1>
      <button class="round" data-newpl aria-label="New playlist">${icon("plus")}</button></div>
    <div style="height:16px"></div>
    <ul class="list">
      <li class="row pl-row" data-openpl="liked"><span class="tile" style="background:var(--sun)">${icon("heart-fill")}</span>
        <span class="row-text"><span class="row-title">Liked songs</span><span class="row-sub"><span class="a">${plural(liked.length)}</span></span></span>
        ${liked.length ? `<button class="rbtn" data-playall="pl:liked" aria-label="Play">${icon("play")}</button>` : ""}</li>
      ${state.playlists
        .map((p, i) => {
          const songs = playlistSongs(p.id);
          listCtx.set("pl:" + p.id, songs.map((s) => s.id));
          const covers = songs.filter((s) => s.cover_path).slice(0, 4);
          const thumb = covers.length >= 4
            ? `<span class="mosaic">${covers.map((s) => art(s)).join("")}</span>`
            : covers.length ? art(covers[0]) : `<span class="tile" style="background:var(--${CARD_COLORS[i % 4] || "lav"})">${icon("note")}</span>`;
          return `<li class="row pl-row" data-openpl="${p.id}">${thumb}
            <span class="row-text"><span class="row-title">${esc(p.name)}</span><span class="row-sub"><span class="a">${plural(songs.length)}</span>${songs.length ? `<i class="sep"></i><span class="t">${totalTime(songs)}</span>` : ""}</span></span>
            ${songs.length ? `<button class="rbtn" data-playall="pl:${p.id}" aria-label="Play">${icon("play")}</button>` : ""}</li>`;
        })
        .join("")}
    </ul>
    ${state.playlists.length ? "" : `<p class="group-note" style="margin-top:18px">Create a playlist with "+", or paste a YouTube playlist link in "Add" and it builds itself.</p>`}`;
  hydrateCovers(root, songById);
  const detail = tab.querySelectorAll(".view")[1];
  if (detail) fillPlaylistDetail(detail, detail.dataset.pl);
}

function openPlaylist(id) {
  if (currentTab !== "playlists") showTab("playlists");
  const tab = $("#tab-playlists");
  tab.querySelectorAll(".view").forEach((v, i) => i > 0 && v.remove());
  tab.querySelector(".view")?.classList.remove("pushed-under");
  pushView("playlists", (v) => {
    v.dataset.pl = id;
    fillPlaylistDetail(v, id);
  });
}

function fillPlaylistDetail(v, id) {
  const isLiked = id === "liked";
  const idx = state.playlists.findIndex((p) => p.id === id);
  const pl = isLiked ? { id: "liked", name: "Liked songs" } : state.playlists[idx];
  if (!pl) return popView("playlists");
  const songs = isLiked ? state.songs.filter((s) => s.liked) : playlistSongs(id);
  const key = "pl:" + id;
  listCtx.set(key, songs.map((s) => s.id));
  const color = isLiked ? "sun" : CARD_COLORS[idx % CARD_COLORS.length];
  v.innerHTML = `<div class="topbar">
      <button class="round" data-back="playlists" aria-label="Back">${icon("chev-left")}</button>
      <span class="topbar-title">Playlist</span>
      ${isLiked ? "" : `<button class="round" data-plmore="${id}" aria-label="More">${icon("more")}</button>`}
    </div>
    <div class="pl-card ${color}">
      ${cardStack(songs)}
      <h1>${esc(pl.name)}</h1>
      <p>${plural(songs.length)}${songs.length ? " · " + totalTime(songs) : ""}</p>
      <div class="card-row">
        ${songs.length ? `<button class="btn btn-ink" data-playall="${key}">${icon("play")}Play</button>
        <button class="btn btn-soft" data-shuffleall="${key}">${icon("shuffle")}</button>` : ""}
        ${isLiked ? "" : `<button class="btn btn-soft" data-pladd="${id}">${icon("plus")}Link</button>`}
      </div>
    </div>
    ${songs.length ? `<ul class="list">${songs.map((s) => songRow(s, key)).join("")}</ul>` :
      `<div class="empty"><p>${isLiked ? "Tap the heart in the player to add songs here." : "Empty. Add songs from the ⋯ menu on any song, or paste a YouTube playlist link."}</p></div>`}`;
  hydrateCovers(v, songById);
}

/* ================= add ================= */
function renderAdd() {
  const tab = $("#tab-add");
  let v = tab.querySelector(".view");
  if (!v) {
    v = document.createElement("div");
    v.className = "view";
    tab.appendChild(v);
    v.innerHTML = `<div class="topbar"><h1 class="page-title" style="margin:8px 0 0;flex:1">Add</h1><span id="pc-pill"></span></div>
      <div style="height:16px"></div>
      <form class="add-card" id="add-form">
        <h2>Add music</h2>
        <p>A link from YouTube, SoundCloud… or a whole playlist.</p>
        <div class="add-input">
          <input class="input" id="add-url" type="url" inputmode="url" placeholder="Paste a link here" autocomplete="off" enterkeyhint="go">
          <button type="button" class="paste-btn" id="paste" aria-label="Paste">${icon("paste")}</button>
        </div>
        <label class="add-target"><span>Add to</span><select id="add-pl"></select></label>
        <button class="btn btn-block" id="add-go" type="submit">Add</button>
      </form>
      <div class="group" style="margin-top:14px">
        <button class="cell" data-upload><span class="ico">${icon("upload")}</span><span class="cell-main">Upload from this phone<small>MP3, M4A, WAV… from Files. From Telegram or WhatsApp, use "Save to Files" first.</small></span></button>
        <div class="cell"><span class="ico">${icon("pc")}</span><span class="cell-main">Or drop files on your PC<small>Any audio file in Music\\Tarab is added automatically.</small></span></div>
      </div>
      <div id="pc-hint"></div>
      <div id="jobs-wrap"></div>
      <p class="group-note" style="margin-top:18px">Want to add straight from YouTube with "Share"? See <button class="btn-text" style="padding:0" data-go="settings">Settings → Share</button>.</p>`;
    $("#add-form").onsubmit = async (e) => {
      e.preventDefault();
      const input = $("#add-url"), btn = $("#add-go");
      if (!input.value.trim()) return input.focus();
      btn.disabled = true;
      try {
        await addLink(input.value, $("#add-pl").value || null);
        input.value = "";
        input.blur();
        haptic();
        toast(workerOnline() ? "Added. Your PC is downloading it" : "Added. Downloads when your PC is on");
      } catch (err) {
        toast(navigator.onLine === false ? "You need internet to add a link" : err.message || "Couldn't add", true);
      } finally {
        btn.disabled = false;
      }
    };
    $("#paste").onclick = async () => {
      try {
        const t = await navigator.clipboard.readText();
        const m = t.match(/https?:\/\/[^\s<>"']+/);
        if (!m) return toast("No link on the clipboard", true);
        $("#add-url").value = m[0];
        haptic();
      } catch {
        toast("Paste the link into the box", true);
      }
    };
  }
  const sel = $("#add-pl");
  const keep = sel.value;
  sel.innerHTML = `<option value="">Library only</option>` + state.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  sel.value = state.playlists.some((p) => p.id === keep) ? keep : "";
  renderPcPill();
  renderJobs();
}

function renderPcPill() {
  const hint = $("#pc-hint");
  if (hint)
    hint.innerHTML = workerOnline() || cloudReady() ? "" : `<div class="group" style="margin-top:14px"><button class="cell accent" data-go="settings">
      <span class="ico">${icon("pc")}</span><span class="cell-main">${state.worker ? "Your PC is off" : "Tarab isn't installed on your PC yet"}<small>${state.worker ? "Songs wait and download as soon as it's on." : "Downloads and online listening run on your PC. See Settings → PC."}</small></span></button></div>`;
  const el = $("#pc-pill");
  if (!el) return;
  const on = workerOnline();
  el.innerHTML = on
    ? `<span class="pc-status on"><span class="dot"></span>PC online</span>`
    : cloudReady()
      ? `<span class="pc-status" style="color:var(--lav)"><span class="dot" style="background:var(--lav)"></span>${cloudInstant() ? "Cloud ready" : "Cloud · every 5 min"}</span>`
      : `<span class="pc-status"><span class="dot"></span>PC offline</span>`;
}

function jobLabel(j) {
  if (j.status === "pending") return workerOnline() ? "In queue…" : cloudReady() ? "Cloud starting…" : "Waiting for your PC";
  if (j.status === "working") {
    const who = j.worker === "cloud" ? "Cloud downloading" : "Downloading";
    return j.progress >= 100 ? "Uploading…" : `${who} ${j.progress || 0}%`;
  }
  if (j.status === "done") return j.song_id ? (isOffline(j.song_id) ? "On phone ✓" : "Arrived · saving…") : "Wsal";
  return j.error || "Something went wrong";
}

function renderJobs() {
  const active = state.jobs.filter((j) => j.status === "pending" || j.status === "working").length;
  for (const badge of [$("#add-badge"), $("#add-badge-2")]) {
    if (!badge) continue;
    badge.hidden = !active;
    badge.textContent = active;
  }
  const wrap = $("#jobs-wrap");
  if (!wrap) return;
  const jobs = state.jobs;
  if (!jobs.length) return void (wrap.innerHTML = "");
  const finished = jobs.some((j) => j.status === "done" || j.status === "error");
  wrap.innerHTML = `<div class="section-h" style="margin-top:22px"><h2>Downloads</h2>${finished ? `<button data-clearjobs>Clear finished</button>` : ""}</div>
    <div class="group"><ul class="jobs">${jobs
      .map((j) => {
        const ico = j.status === "done" ? "check" : j.status === "error" ? "x" : "cloud-down";
        const pct = j.status === "working" ? Math.max(4, j.progress || 0) : 0;
        return `<li class="job ${j.status}" ${j.status === "done" && j.song_id ? `data-song="${j.song_id}" data-ctx="all"` : ""}>
          <span class="job-icon">${icon(ico)}</span>
          <span class="job-main"><div class="job-title">${esc(j.title || j.url)}</div><div class="job-state">${esc(jobLabel(j))}</div>
          ${j.status === "error" ? `<div class="job-actions"><button class="chip sm" data-jlink="${j.id}">${icon("link")}Paste a link</button>
            <a class="chip sm" href="https://www.youtube.com/results?search_query=${encodeURIComponent(j.meta ? `${j.meta.artist || ""} ${j.meta.title || ""}` : j.title || "")}" target="_blank" rel="noopener">${icon("search")}Find on YouTube</a></div>` : ""}
          ${j.status === "working" || j.status === "pending" ? `<div class="job-bar"><i style="width:${j.status === "working" ? pct + "%" : ""}"></i></div>` : ""}</span>
          ${j.status === "error" ? `<button class="round" data-retry="${j.id}" aria-label="Retry">${icon("retry")}</button>` : ""}
          ${j.status !== "working" ? `<button class="round" data-deljob="${j.id}" aria-label="Remove">${icon("x")}</button>` : ""}
        </li>`;
      })
      .join("")}</ul></div>`;
}

/* ================= settings ================= */
function mixDiagram(fade) {
  const W = 320, ov = 40 + fade * 9, aEnd = 210, bStart = aEnd - ov;
  return `<svg class="mix-diagram" viewBox="0 0 ${W} 58" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 14 H${bStart} L${aEnd} 44 V48 H0 Z" fill="rgba(199,164,246,.35)"/>
    <path d="M${bStart} 48 L${aEnd} 14 H${W} V48 Z" fill="rgba(246,196,83,.55)"/>
    <rect x="${bStart}" y="4" width="${ov}" height="50" rx="4" fill="none" stroke="#f6c453" stroke-dasharray="3 3"/>
    <text x="8" y="38" fill="#f6f4fb" font-size="11" font-weight="700" font-family="Urbanist,system-ui">Song 1</text>
    <text x="${W - 8}" y="38" fill="#231a04" font-size="11" font-weight="700" text-anchor="end" font-family="Urbanist,system-ui">Song 2</text>
  </svg>`;
}

async function renderSettings() {
  const tab = $("#tab-settings");
  let v = tab.querySelector(".view");
  if (!v) {
    v = document.createElement("div");
    v.className = "view";
    tab.appendChild(v);
  }
  const s = player.settings;
  const est = await storageEstimate();
  const off = state.songs.filter((x) => isOffline(x.id)).length;
  const used = est?.usage ? (est.usage / 1048576).toFixed(0) + " MB" : "—";
  const zip = location.origin + location.pathname.replace(/[^/]*$/, "") + "pc/Tarab-PC.zip";
  v.innerHTML = `<div class="topbar"><button class="avatar" data-profile style="width:60px;height:60px" aria-label="Profile">${avatarImg()}</button>
      <span class="grow greet"><b style="font-size:22px">${esc(displayName())}</b><small>${esc(state.user?.email || "")}</small></span>
      <button class="pill-btn" data-signout aria-label="Sign out">${icon("logout")}Sign out</button></div>

    <p class="group-label">AutoMix</p>
    <div class="group">
      <label class="cell"><span class="cell-main">AutoMix<small>Blends one song into the next and trims silence at the start and end</small></span>
        <span class="switch"><input type="checkbox" id="s-mix" ${s.automix ? "checked" : ""}><i></i></span></label>
      <div class="cell" style="display:block;${s.automix ? "" : "opacity:.4"}">
        <div style="display:flex;justify-content:space-between"><span>Transition length</span><b id="s-fade-v" style="color:var(--sun)">${s.fade}s</b></div>
        <div id="mix-diag">${mixDiagram(s.fade)}</div>
        <input type="range" class="range" id="s-fade" min="2" max="12" step="1" value="${s.fade}" style="--p:${((s.fade - 2) / 10) * 100}%" ${s.automix ? "" : "disabled"}>
      </div>
    </div>
    <p class="group-note">${IS_IOS ? "On iPhone, AutoMix skips the silence between songs instead of blending, so music keeps playing and the lock screen controls work." : "Songs blend into each other at the end."}</p>

    <p class="group-label">Offline</p>
    <div class="group">
      <label class="cell"><span class="cell-main">Keep everything on this phone<small>Every song you add saves itself here, so it plays without internet</small></span>
        <span class="switch"><input type="checkbox" id="s-off" ${s.autoOffline ? "checked" : ""}><i></i></span></label>
      <div class="cell"><span class="cell-main">On this phone</span><span class="value">${off}/${state.songs.length} · ${used}</span></div>
      ${s.autoOffline ? "" : `<button class="cell danger" data-clear-offline><span class="cell-main">Remove music from this phone</span></button>`}
    </div>
    <p class="group-note">${s.autoOffline ? "To free space on the phone, turn off the first option." : "Your music stays in your account. This only frees space on the phone."}</p>

    <p class="group-label">PC</p>
    <div class="group">
      <div class="cell"><span class="ico">${icon("pc")}</span><span class="cell-main">${workerOnline() ? "On and working" : state.worker ? "Off" : "Not installed yet"}<small>${state.worker ? "Last seen: " + esc(new Date(state.worker.last_seen).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })) : "Open this link on your PC, download, and double-click install.bat"}</small></span>
        <span class="pc-status ${workerOnline() ? "on" : ""}" style="padding:0 12px"><span class="dot"></span></span></div>
      <div class="cell" style="display:block"><span class="code">${esc(zip)}</span></div>
      <button class="cell accent" data-copy="${esc(zip)}"><span class="cell-main">Copy link</span></button>
    </div>

    <p class="group-label">Add from YouTube with "Share"</p>
    <div class="group" id="shortcut-box"><div class="cell"><span class="cell-main muted">Loading…</span></div></div>


    <p class="group-label">Discord</p>
    <div class="group" id="discord-box"></div>

    <p class="group-label">Account</p>
    <div class="group">
      <button class="cell" data-profile-photo><span class="cell-main">Change your picture</span></button>
      <button class="cell" data-rename><span class="cell-main">Change your name</span><span class="value">${esc(displayName())}</span></button>
      <button class="cell danger" data-signout><span class="ico">${icon("logout")}</span><span class="cell-main">Sign out<small>${esc(state.user?.email || "")}</small></span></button>
    </div>
    <p class="group-note" style="margin-top:14px">Tarab ${APP_VERSION}</p>`;

  $("#s-mix").onchange = (e) => {
    player.setSettings({ automix: e.target.checked });
    renderSettings();
  };
  $("#s-off").onchange = (e) => {
    player.setSettings({ autoOffline: e.target.checked });
    if (e.target.checked) maybeSync();
    renderSettings();
    renderSync();
  };
  const fade = $("#s-fade");
  fade.oninput = () => {
    const val = +fade.value;
    fade.style.setProperty("--p", ((val - 2) / 10) * 100 + "%");
    $("#s-fade-v").textContent = val + "s";
    $("#mix-diag").innerHTML = mixDiagram(val);
  };
  fade.onchange = () => player.setSettings({ fade: +fade.value });
  fillShortcut();
  fillDiscord();
}

function stPill(cls, text) {
  return `<span class="st-pill ${cls}"><span class="dot"></span>${esc(text)}</span>`;
}

async function fillCloud() {
  const box = $("#cloud-box");
  if (!box) return;
  const st = state.settings || {};
  const ready = cloudReady();
  const last = st.last_dispatch ? new Date(st.last_dispatch).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : null;
  const seen = st.cloud_seen ? new Date(st.cloud_seen).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : null;
  const sub = cloudInstant()
    ? (last ? "Starts instantly · last run " + esc(last) : "Starts instantly when your PC is off")
    : cloudTimer()
      ? "Active · checks every ~5 min · last check " + esc(seen)
      : "Free. Downloads your songs when your PC is off. Takes about 5 minutes to set up.";
  box.innerHTML = `<div class="cell"><span class="ico">${icon("cloud")}</span><span class="cell-main">GitHub Actions<small>${sub}</small></span>
      ${ready ? stPill("ok", cloudInstant() ? "Instant" : "Active") : stPill("", "Not set up")}</div>
    <ol class="steps">
      <li>Go to <b>github.com</b> and sign in (a free account is enough).</li>
      <li><b>+ → New repository</b>: name it <b>tarab-cloud</b>, choose <b>Public</b> (free unlimited minutes; only this file lives there, your password stays secret), tick <b>Add a README</b> → <b>Create</b>.</li>
      <li>In the repo: <b>Add file → Create new file</b>. Name: <span class="code">.github/workflows/tarab.yml</span>Paste the file (button below) → <b>Commit changes</b>.</li>
      <li><b>Settings → Secrets and variables → Actions → New repository secret</b>: <b>TARAB_EMAIL</b> = your Tarab email, then another one: <b>TARAB_PASSWORD</b> = your Tarab password.</li>
      <li><b>Actions</b> tab → <b>tarab</b> → <b>Run workflow</b> once. Done: from now on it checks every ~5 min, and this card turns <b>Active</b>.</li>
    </ol>
    <button class="cell accent" data-copy-yml><span class="cell-main">Copy tarab.yml</span></button>
    <p class="group-note" style="padding:12px 16px 4px;margin:0">Optional, for instant start instead of ~5 min: a token from <b>github.com/settings/personal-access-tokens/new</b> → Only select → <b>tarab-cloud</b> → Permissions: <b>Actions: Read and write</b>.</p>
    <form class="cloud-form" id="cloud-form">
      <input class="input" id="gh-repo" placeholder="yourname/tarab-cloud" value="${esc(st.github_repo || "")}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <input class="input" id="gh-token" type="password" placeholder="${st.has_token ? "Token saved ✓ (leave empty)" : "github_pat_… (optional)"}" autocomplete="off">
      <div class="btns"><button class="btn btn-lav" type="submit">Save</button>${cloudInstant() ? `<button class="btn btn-dark" type="button" data-cloud-test>Test now</button>` : ""}</div>
    </form>
`;
  $("#cloud-form").onsubmit = async (e) => {
    e.preventDefault();
    const repo = $("#gh-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    const token = $("#gh-token").value.trim();
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("Repo should look like yourname/tarab-cloud", true);
    const patch = { github_repo: repo || null, cloud_enabled: true };
    if (token) patch.github_token = token;
    try {
      await saveUserSettings(patch);
      toast("Saved ✓");
      fillCloud();
      renderPcPill();
    } catch (err) {
      toast(err.message || "Couldn't save", true);
    }
  };
}

async function fillDiscord() {
  const box = $("#discord-box");
  if (!box) return;
  const st = state.settings || {};
  const on = !!st.discord_app_id && st.discord_enabled !== false;
  box.innerHTML = `<label class="cell"><span class="ico">${icon("discord")}</span><span class="cell-main">Show what I'm playing on Discord<small>Cover, title, artist and time, from your phone or PC. Needs your PC on with Discord open.</small></span>
      <span class="switch"><input type="checkbox" id="dc-on" ${st.discord_enabled !== false ? "checked" : ""}><i></i></span></label>
    <form class="cloud-form" id="dc-form">
      <input class="input" id="dc-id" inputmode="numeric" placeholder="Application ID (like 1234567890123456789)" value="${esc(st.discord_app_id || "")}" autocomplete="off">
      <div class="btns"><button class="btn btn-lav" type="submit">Save</button>${on ? stPill("ok", "Ready") : ""}</div>
    </form>
    <ol class="steps">
      <li>Open <b>discord.com/developers/applications</b> → <b>New Application</b> → name it <b>Tarab</b> (that name is what people see).</li>
      <li>Copy the <b>Application ID</b>, paste it above → <b>Save</b>.</li>
      <li>In Discord on your PC: <b>Settings → Activity Privacy</b> → turn on <b>Share my activity</b>.</li>
      <li>Update the PC script (run install.bat again). From then on, whatever you play shows on your profile.</li>
    </ol>`;
  $("#dc-form").onsubmit = async (e) => {
    e.preventDefault();
    const id = $("#dc-id").value.trim();
    if (id && !/^\d{15,22}$/.test(id)) return toast("Application ID should be digits only", true);
    try {
      await saveUserSettings({ discord_app_id: id || null });
      toast("Saved ✓");
      fillDiscord();
      publishNP(true);
    } catch (err) {
      toast(err.message || "Couldn't save", true);
    }
  };
  $("#dc-on").onchange = async (e) => {
    try {
      await saveUserSettings({ discord_enabled: e.target.checked });
      publishNP(true);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

async function fillShortcut() {
  const box = $("#shortcut-box");
  if (!box) return;
  let token = null;
  try { token = await getShareToken(); } catch {}
  if (!token) return void (box.innerHTML = `<div class="cell"><span class="cell-main muted">You need internet to see this.</span></div>`);
  box.innerHTML = `<ol class="steps">
      <li>Open the <b>Shortcuts</b> app → <b>+</b>.</li>
      <li>Add the action <b>"Get Contents of URL"</b>. URL:<span class="code">${esc(SHARE_ENDPOINT)}</span></li>
      <li>Tap <b>⌄</b>: Method = <b>POST</b>, Request Body = <b>JSON</b>. Add 2 Text fields:<br>
        <b>token</b> = <span class="code">${esc(token)}</span><b>url</b> = tap and choose <b>Shortcut Input</b>.</li>
      <li>Add the action <b>"Show Notification"</b>.</li>
      <li>At the top: name → <b>Details</b> → turn on <b>"Show in Share Sheet"</b>. Name it <b>Tarab</b>.</li>
      <li>Now in YouTube: <b>Share</b> → <b>Tarab</b>.</li>
    </ol>
    <button class="cell accent" data-copy="${esc(SHARE_ENDPOINT)}"><span class="cell-main">Copy URL</span></button>
    <button class="cell accent" data-copy="${esc(token)}"><span class="cell-main">Copy token</span></button>`;
}

/* ================= now playing ================= */
const np = $("#np");
let npOpen = false;
let npSongId = null;

function openNP() {
  if (!player.song) return;
  npOpen = true;
  np.classList.add("open");
  np.setAttribute("aria-hidden", "false");
  if (isDesktop()) $("#np-queue").hidden = false;
  updateNP(true);
}
function closeNP() {
  npOpen = false;
  np.classList.remove("open");
  np.setAttribute("aria-hidden", "true");
  $("#np-queue").hidden = true;
  if (lyOpen) closeLyrics();
}

function queueAt(offset) {
  const q = player.queue;
  if (!q.length) return null;
  let i = player.index + offset;
  if (player.repeat === "all") i = ((i % q.length) + q.length) % q.length;
  return i >= 0 && i < q.length && i !== player.index ? songById(q[i]) : null;
}

function updateNextLines() {
  const prev = queueAt(-1), next = queueAt(1), after = queueAt(2);
  const l0 = $(".l0", np), l1 = $(".l1", np), l2 = $(".l2", np);
  const fade = player.fadeInfo;
  l0.textContent = prev ? prev.title : "";
  if (fade) {
    const to = songById(fade.to);
    l1.textContent = `AutoMix → ${to?.title || ""}`;
  } else if (player.repeat === "one") {
    l1.textContent = "Repeating this song";
  } else {
    l1.textContent = next ? `Next · ${next.title}${next.artist ? " — " + next.artist : ""}` : "Last song in the queue";
  }
  l1.classList.toggle("mix", !!fade);
  l2.textContent = after && !fade ? after.title : "";
}

async function updateNP(force = false) {
  const s = player.song;
  if (!s) return;
  np.classList.toggle("playing", player.playing || player.fading);
  $(".play-btn use", np).setAttribute("href", player.playing ? "#i-pause" : "#i-play");
  $(".play-btn", np).setAttribute("aria-label", player.playing ? "Pause" : "Play");
  $('.ly-foot [data-np="toggle"] use', np).setAttribute("href", player.playing ? "#i-pause" : "#i-play");
  const like = $(".np-like", np);
  np.classList.toggle("streaming", player.streaming);
  if (!player.streaming || player.playing) np.classList.remove("needs-tap");
  $("#np-online").hidden = !s.stream;
  if (s.stream) {
    const st = catalogStatus(s.deezer_id);
    like.classList.toggle("on", st === "have" || st === "queued");
    $("use", like).setAttribute("href", st === "have" || st === "queued" ? "#i-check" : "#i-plus");
    like.setAttribute("aria-label", "Add to library");
  } else {
    like.classList.toggle("on", !!s.liked);
    $("use", like).setAttribute("href", s.liked ? "#i-heart-fill" : "#i-heart");
    like.setAttribute("aria-label", "Like");
  }
  $('[data-np="shuffle"]', np).setAttribute("aria-pressed", String(player.shuffle));
  const rep = $('.np-controls [data-np="repeat"]', np);
  rep.classList.toggle("on", player.repeat !== "off");
  $("use", rep).setAttribute("href", player.repeat === "one" ? "#i-repeat-1" : "#i-repeat");
  $(".chip.mix", np).setAttribute("aria-pressed", String(!!player.settings.automix));
  updateNextLines();

  if (s.id !== npSongId || force) {
    npSongId = s.id;
    $(".np-title", np).textContent = s.title;
    $(".np-artist", np).textContent = s.artist || "";
    const img = $(".np-art-cur", np);
    setImg(img, coverURLSync(s.id));
    getCoverURL(s).then((u) => u && npSongId === s.id && setImg(img, u));
    const c = await coverColors(s);
    if (npSongId === s.id) {
      np.style.setProperty("--np-a", c.a);
      np.style.setProperty("--np-b", c.b);
    }
  }
  updateScrub();
  if (!$("#np-queue").hidden) renderQueue();
}

let scrubbing = false, scrubT = 0;
function updateScrub() {
  const d = player.duration, t = scrubbing ? scrubT : player.time;
  const pct = d ? Math.min(100, (t / d) * 100) : 0;
  const mp = player.mixPoint;
  const zone = mp != null && d ? Math.max(0, ((d - mp) / d) * 100) + "%" : "0";
  for (const el of [$("#scrub"), $("#db-scrub")]) {
    if (!el) continue;
    $(".scrub-fill", el).style.width = pct + "%";
    $(".scrub-knob", el).style.left = pct + "%";
    $(".scrub-zone", el).style.width = zone;
  }
  $("#t-cur").textContent = fmt(t);
  $("#t-left").textContent = fmt(d);
  $("#db-cur").textContent = fmt(t);
  $("#db-dur").textContent = fmt(d);
  $("#ly-fill").style.width = pct + "%";
  $(".ring-fg").style.strokeDashoffset = String(141.4 * (1 - pct / 100));
}

function bindScrub() {
  bindScrubEl($("#scrub"));
  bindScrubEl($("#db-scrub"));
}

function bindScrubEl(el) {
  const track = $(".scrub-track", el);
  const at = (x) => {
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width)) * player.duration;
  };
  el.addEventListener("pointerdown", (e) => {
    if (!player.duration) return;
    scrubbing = true;
    el.classList.add("active");
    el.setPointerCapture(e.pointerId);
    scrubT = at(e.clientX);
    updateScrub();
  });
  el.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    scrubT = at(e.clientX);
    updateScrub();
  });
  const end = () => {
    if (!scrubbing) return;
    scrubbing = false;
    el.classList.remove("active");
    player.seek(scrubT);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function bindNPDrag() {
  let y0 = null, dy = 0;
  const zone = $(".np-inner", np);
  zone.addEventListener("touchstart", (e) => {
    if (e.target.closest(".scrub, .np-controls, .np-chips, button")) return;
    y0 = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  zone.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 6) {
      np.classList.add("dragging");
      np.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });
  zone.addEventListener("touchend", () => {
    if (y0 == null) return;
    np.classList.remove("dragging");
    np.style.transform = "";
    if (dy > 110) closeNP();
    y0 = null;
  });
}

/* ================= lyrics ================= */
const lyPanel = $("#np-lyrics");
let lyOpen = false, lySongId = null, lyLines = null, lyIdx = -2, lyFreeUntil = 0, lyTimer = 0;

function openLyrics() {
  if (!player.song) return;
  if (!npOpen) openNP();
  lyOpen = true;
  lyPanel.hidden = false;
  np.classList.add("lyrics-on");
  $('.np-chips [data-np="lyrics"]').setAttribute("aria-pressed", "true");
  $("[data-open-lyrics]")?.classList.add("on");
  renderLyrics(true);
  clearInterval(lyTimer);
  lyTimer = setInterval(syncLyrics, 200);
}
function closeLyrics() {
  lyOpen = false;
  lyPanel.hidden = true;
  np.classList.remove("lyrics-on");
  $('.np-chips [data-np="lyrics"]').setAttribute("aria-pressed", "false");
  $("[data-open-lyrics]")?.classList.remove("on");
  clearInterval(lyTimer);
}

async function renderLyrics(force = false, refresh = false) {
  const s = player.song;
  if (!s || (!force && s.id === lySongId)) return;
  lySongId = s.id;
  lyLines = null;
  lyIdx = -2;
  $("#ly-title").textContent = s.title;
  $("#ly-artist").textContent = s.artist || "";
  const img = $(".ly-art img", lyPanel);
  setImg(img, coverURLSync(s.id));
  getCoverURL(s).then((u) => u && lySongId === s.id && setImg(img, u));
  const body = $("#ly-body"), sc = $("#ly-scroll");
  body.className = "ly-body";
  body.innerHTML = `<div class="ly-loading"><i></i><i></i><i></i><i></i></div>`;
  sc.scrollTop = 0;
  const r = await getLyrics(s, { refresh });
  if (lySongId !== s.id) return;
  if (r?.synced?.length) {
    lyLines = r.synced;
    body.innerHTML = lyLines
      .map((l, i) => l.text
        ? `<button class="ly-line" data-lt="${l.t}" data-li="${i}">${esc(l.text)}</button>`
        : `<span class="ly-line gap" data-li="${i}"></span>`)
      .join("");
    syncLyrics(true);
  } else if (r?.plain) {
    body.className = "ly-body ly-plain-wrap";
    body.style.paddingTop = "18px";
    body.innerHTML = `<span class="ly-note">${icon("lyrics")}Not synced for this song</span><div class="ly-plain">${esc(r.plain)}</div>`;
  } else {
    body.style.paddingTop = "";
    const offline = !r;
    body.innerHTML = `<div class="ly-empty">${icon("lyrics")}
      <h3>${offline ? "Lyrics need internet" : "No lyrics yet"}</h3>
      <p>${offline ? "Open this once while online and they stay on your phone." : "Nobody has added lyrics for this song yet."}</p>
      <button class="btn btn-dark" data-ly-retry>${icon("retry")}Try again</button></div>`;
  }
  if (r?.synced?.length) body.style.paddingTop = "";
}

function syncLyrics(jump = false) {
  if (!lyOpen || !lyLines) return;
  const t = player.time + 0.3;
  let lo = 0, hi = lyLines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyLines[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const sc = $("#ly-scroll");
  sc.classList.toggle("free", Date.now() < lyFreeUntil);
  if (idx === lyIdx && !jump) return;
  lyIdx = idx;
  const els = $$(".ly-line", sc);
  els.forEach((el, i) => {
    el.classList.toggle("on", i === idx);
    el.classList.toggle("past", i < idx);
  });
  if (Date.now() < lyFreeUntil && !jump) return;
  const cur = els[Math.max(0, idx)];
  if (cur) {
    const top = cur.offsetTop - sc.clientHeight * 0.36;
    sc.scrollTo({ top: Math.max(0, top), behavior: jump ? "auto" : "smooth" });
  }
}

(() => {
  const sc = $("#ly-scroll");
  const free = () => { lyFreeUntil = Date.now() + 3500; };
  sc.addEventListener("wheel", free, { passive: true });
  sc.addEventListener("touchstart", free, { passive: true });
  sc.addEventListener("touchmove", free, { passive: true });
})();

// fetch lyrics for the playing song in the background so opening the panel is instant
let lyPrefetched = null;
function prefetchLyrics() {
  const s = player.song;
  if (!s || s.id === lyPrefetched || navigator.onLine === false) return;
  lyPrefetched = s.id;
  setTimeout(() => player.song?.id === s.id && getLyrics(s), 1500);
}

function renderQueue() {
  const ol = $("#np-queue-list");
  const items = player.queue.map((id, i) => ({ s: songById(id), i })).filter((x) => x.s && x.i >= player.index);
  ol.innerHTML = items
    .map(({ s, i }) => `<li class="row ${i === player.index ? "now" : ""}" data-qi="${i}">${art(s)}
      <span class="row-text"><span class="row-title">${esc(s.title)}</span><span class="row-sub"><span class="a">${i === player.index ? "Now playing" : esc(s.artist || "")}</span></span></span>
      ${i === player.index ? "" : `<button class="rbtn" data-qrm="${i}" aria-label="Remove">${icon("x")}</button>`}</li>`)
    .join("");
  hydrateCovers(ol, songById);
}

function showMixState() {
  const info = player.fadeInfo;
  if (!info) {
    np.classList.remove("mixing");
    if (npOpen) updateNextLines();
    return;
  }
  setImg($(".np-art-next", np), coverURLSync(info.to));
  np.style.setProperty("--mixdur", info.dur + "s");
  np.classList.remove("mixing");
  void np.offsetWidth;
  np.classList.add("mixing");
  if (npOpen) updateNextLines();
}

/* ================= mini player ================= */
function updateMini() {
  const s = player.song, mini = $("#mini");
  mini.hidden = !s;
  if (!s) return;
  $(".mini-title", mini).textContent = s.title;
  $(".mini-artist", mini).textContent = s.artist || "";
  const img = $(".mini-disc img", mini);
  const u = coverURLSync(s.id);
  setImg(img, u);
  if (!u) getCoverURL(s).then((x) => x && player.song?.id === s.id && setImg(img, x));
  $('[data-act="toggle"] use', mini).setAttribute("href", player.playing ? "#i-pause" : "#i-play");
  mini.classList.toggle("loading", player.loading);
}

/* ================= desktop ================= */
function renderSidebar() {
  const box = $("#sb-pls");
  if (!box) return;
  const liked = state.songs.filter((s) => s.liked).length;
  box.innerHTML = `<button data-openpl="liked"><span class="sw" style="background:var(--sun)">${icon("heart-fill")}</span><span>Liked · ${liked}</span></button>` +
    state.playlists.map((p, i) => `<button data-openpl="${p.id}"><span class="sw" style="background:var(--${CARD_COLORS[i % 4] || "lav"})">${icon("note")}</span><span>${esc(p.name)}</span></button>`).join("");
  $("#sb-avatar").innerHTML = avatarImg();
  $("#sb-name").textContent = displayName();
}

function updateDeskbar() {
  const bar = $("#deskbar");
  if (!bar) return;
  const s = player.song;
  bar.hidden = !s;
  bar.classList.toggle("playing", player.playing);
  if (!s) return;
  $(".db-title", bar).textContent = s.title;
  $(".db-artist", bar).textContent = s.artist || "";
  const img = $(".db-art img", bar);
  setImg(img, coverURLSync(s.id));
  if (!coverURLSync(s.id)) getCoverURL(s).then((u) => u && player.song?.id === s.id && setImg(img, u));
  $('[data-np="toggle"] use', bar).setAttribute("href", player.playing ? "#i-pause" : "#i-play");
  const like = $(".db-like", bar);
  if (s.stream) {
    const st = catalogStatus(s.deezer_id);
    like.classList.toggle("on", !!st);
    $("use", like).setAttribute("href", st ? "#i-check" : "#i-plus");
  } else {
    like.classList.toggle("on", !!s.liked);
    $("use", like).setAttribute("href", s.liked ? "#i-heart-fill" : "#i-heart");
  }
  $('[data-np="shuffle"]', bar).classList.toggle("on", player.shuffle);
  const rep = $('[data-np="repeat"]', bar);
  rep.classList.toggle("on", player.repeat !== "off");
  $("use", rep).setAttribute("href", player.repeat === "one" ? "#i-repeat-1" : "#i-repeat");
  $(".chip.mix", bar).setAttribute("aria-pressed", String(!!player.settings.automix));
  updateVolumeUI();
}

let lastVolume = 1;
function updateVolumeUI() {
  const v = player.settings.volume ?? 1;
  const r = $("#db-vol");
  if (!r) return;
  r.value = v;
  r.style.setProperty("--p", v * 100 + "%");
  $('[data-mute] use').setAttribute("href", v === 0 ? "#i-vol-off" : "#i-vol");
}
$("#db-vol")?.addEventListener("input", (e) => {
  player.setVolume(+e.target.value);
  updateVolumeUI();
});

// keyboard shortcuts (desktop)
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === " " || k === "k") { e.preventDefault(); player.toggle(); }
  else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? player.next() : player.seek(player.time + 5); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? player.prev() : player.seek(player.time - 5); }
  else if (k === "ArrowUp") { e.preventDefault(); player.setVolume((player.settings.volume ?? 1) + 0.05); updateVolumeUI(); }
  else if (k === "ArrowDown") { e.preventDefault(); player.setVolume((player.settings.volume ?? 1) - 0.05); updateVolumeUI(); }
  else if (k === "m") { const v = player.settings.volume ?? 1; if (v > 0) { lastVolume = v; player.setVolume(0); } else player.setVolume(lastVolume || 1); updateVolumeUI(); }
  else if (k === "l" && player.song && !player.song.stream) { setLiked(player.song, !player.song.liked).then(() => { updateDeskbar(); if (npOpen) updateNP(); }).catch(() => {}); }
  else if (k === "/") { e.preventDefault(); showTab("search"); setTimeout(() => $("#sq")?.focus(), 50); }
  else if (k === "y" && player.song) { lyOpen ? closeLyrics() : openLyrics(); }
  else if (k === "Escape" && lyOpen) closeLyrics();
  else if (k === "Escape" && npOpen) closeNP();
});

// "Install app" on Chrome / Edge
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  const b = $("#sb-install");
  if (b) b.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installEvt = null;
  $("#sb-install").hidden = true;
  toast("Tarab installed on this PC ✓");
});

/* ---- tell Discord (through the PC) what's playing ---- */
let pubTimer = null, lastPub = null;
function deviceName() {
  return /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "PC";
}
function coverUrlFor(s) {
  if (s.cover_url) return s.cover_url;
  const m = (s.source_url || "").match(/(?:youtu\.be\/|[?&]v=)([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}
function publishNP(force = false) {
  if (!state.settings?.discord_app_id || !state.user) return;
  clearTimeout(pubTimer);
  pubTimer = setTimeout(async () => {
    const s = player.song;
    const row = s
      ? { song_id: s.id, title: s.title, artist: s.artist, album: s.album, cover_url: coverUrlFor(s), source_url: s.source_url,
          duration: player.duration || s.duration, position: player.time, playing: player.playing, device: deviceName() }
      : { playing: false };
    // skip if nothing meaningful changed (same song, same state, position where we'd expect it)
    if (!force && lastPub && lastPub.song_id === row.song_id && lastPub.playing === row.playing) {
      const expected = lastPub.position + (row.playing ? (Date.now() - lastPub.at) / 1000 : 0);
      if (Math.abs(expected - (row.position || 0)) < 3) return;
    }
    try {
      await publishNowPlaying(row);
      lastPub = { ...row, at: Date.now() };
    } catch {}
  }, 500);
}

/* ================= song actions ================= */
async function songMenu(id, ctx) {
  const s = songById(id);
  if (!s) return;
  if (s.stream) {
    const head = `<div class="sheet-head">${art(s)}<div><b>${esc(s.title)}</b><small>${esc(s.artist || "")} · Online</small></div></div>`;
    const v = await actionSheet(head, [
      { id: "add", label: "Add to library (download)", icon: "plus" },
      { id: "addpl", label: "Add to playlist", icon: "stack" },
      { id: "next", label: "Play next", icon: "next-up" },
    ]);
    if (v === "add") await addTracks([trackFromSong(s)]);
    if (v === "next") { player.playNext(s.id); toast("Plays after this song"); }
    if (v === "addpl") {
      const items = [{ id: "__new", label: "New playlist", icon: "plus" }, ...state.playlists.map((p) => ({ id: p.id, label: p.name, icon: "stack" }))];
      const pick = await actionSheet(`<div class="sheet-head"><div><b>Add to playlist</b></div></div>`, items);
      if (!pick) return;
      let name = state.playlists.find((p) => p.id === pick)?.name;
      if (pick === "__new") name = await promptSheet("Playlist name", "", "Sawb");
      if (name) await addTracks([trackFromSong(s)], name);
    }
    return;
  }
  const plId = ctx?.startsWith("pl:") && ctx !== "pl:liked" ? ctx.slice(3) : null;
  const head = `<div class="sheet-head">${art(s)}<div><b>${esc(s.title)}</b><small>${esc(s.artist || "")}</small></div></div>`;
  const items = [
    { id: "next", label: "Play next", icon: "next-up" },
    { id: "like", label: s.liked ? "Unlike" : "Like", icon: s.liked ? "heart-fill" : "heart" },
    { id: "addpl", label: "Add to playlist", icon: "stack" },
    plId && { id: "rmpl", label: "Remove from this playlist", icon: "x" },
    { id: "edit", label: "Rename", icon: "pencil" },
    { id: "del", label: "Delete", icon: "trash", danger: true },
  ].filter(Boolean);
  const v = await actionSheet(head, items);
  try {
    if (v === "next") { player.playNext(s.id); toast("Plays after this song"); }
    if (v === "like") { await setLiked(s, !s.liked); haptic(); }
    if (v === "addpl") await pickPlaylist(s);
    if (v === "rmpl") { await removeFromPlaylist({ id: plId }, s); toast("Removed"); }
    if (v === "edit") {
      const t = await promptSheet("Song title", s.title, "Kemmel");
      if (!t) return;
      const a = await promptSheet("Artiste", s.artist || "", "Save");
      await renameSong(s, t, a ?? s.artist);
    }
    if (v === "del") {
      if (!(await confirmSheet(`Delete "${s.title}"?`, "Delete everywhere"))) return;
      player.forget(s.id);
      await removeOffline(s.id);
      await deleteSong(s);
      toast("Deleted");
    }
  } catch (e) {
    toast(navigator.onLine === false ? "You need internet for this" : e.message || "Something went wrong", true);
  }
}

async function pickPlaylist(song) {
  const items = [{ id: "__new", label: "New playlist", icon: "plus" }, ...state.playlists.map((p) => ({ id: p.id, label: p.name, icon: "stack" }))];
  const v = await actionSheet(`<div class="sheet-head"><div><b>Add to playlist</b></div></div>`, items);
  if (!v) return;
  let pl = state.playlists.find((p) => p.id === v);
  if (v === "__new") {
    const name = await promptSheet("Playlist name", "", "Sawb");
    if (!name) return;
    pl = await createPlaylist(name);
  }
  const added = await addToPlaylist(pl, song);
  toast(added ? `Added to ${pl.name}` : `Already in ${pl.name}`);
}

async function playlistMenu(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  const v = await actionSheet(`<div class="sheet-head"><div><b>${esc(pl.name)}</b></div></div>`, [
    { id: "rename", label: "Rename", icon: "pencil" },
    { id: "add", label: "Add a link to this playlist", icon: "plus" },
    { id: "del", label: "Delete playlist", icon: "trash", danger: true },
  ]);
  try {
    if (v === "rename") {
      const n = await promptSheet("New name", pl.name);
      if (n) await renamePlaylist(pl, n);
    }
    if (v === "add") await addLinkTo(id);
    if (v === "del" && (await confirmSheet(`Delete "${pl.name}"? The songs stay.`, "Delete playlist"))) {
      await deletePlaylist(pl);
      popView("playlists");
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function addLinkTo(plId) {
  const url = await promptSheet("Song or playlist link", "", "Add", "https://youtube.com/…");
  if (!url) return;
  try { await addLink(url, plId); toast("Added. It will land in this playlist"); } catch (err) { toast(err.message, true); }
}

async function playFrom(ctx, songId) {
  const ids = listCtx.get(ctx) || [songId];
  const has = ids.includes(songId);
  haptic();
  await player.playList(has ? ids : [songId], has ? ids.indexOf(songId) : 0);
}

/* ================= long press = song menu ================= */
let pressTimer = null, pressed = false, pressXY = null;
document.addEventListener("touchstart", (e) => {
  const row = e.target.closest(".row[data-song]");
  if (!row || e.target.closest("button")) return;
  pressed = false;
  pressXY = [e.touches[0].clientX, e.touches[0].clientY];
  pressTimer = setTimeout(() => {
    pressed = true;
    haptic();
    songMenu(row.dataset.song, row.dataset.ctx);
  }, 480);
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!pressTimer || !pressXY) return;
  const t = e.touches[0];
  if (Math.abs(t.clientX - pressXY[0]) + Math.abs(t.clientY - pressXY[1]) > 10) clearTimeout(pressTimer);
}, { passive: true });
document.addEventListener("touchend", () => clearTimeout(pressTimer));


/* ================= search: artists, songs, albums (Deezer catalogue) ================= */
const pv = new Audio();
pv.preload = "none";
let pvId = null, pvResume = false;
const catTracks = new Map(); // deezer id -> track
const artistData = new Map();
const albumData = new Map();
let chartData = null, searchSeq = 0, searchTimer = null, lastResults = null, showAllTracks = false;
const remember = (list) => (list || []).forEach((t) => catTracks.set(String(t.id), t));

function recentList() {
  try { return JSON.parse(localStorage.getItem("tarab-recent") || "[]"); } catch { return []; }
}
function pushRecent(q) {
  q = q.trim();
  if (!q) return;
  const list = [q, ...recentList().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  try { localStorage.setItem("tarab-recent", JSON.stringify(list)); } catch {}
}

function addBtn(id) {
  const st = catalogStatus(Number(id));
  const inner = st === "have" ? icon("check") : st === "queued" ? `<span class="spin"></span>` : icon("plus");
  const label = st === "have" ? "In library" : st === "queued" ? "Downloading" : "Add";
  return `<button class="addbtn ${st || ""}" data-cadd="${id}" aria-label="${label}">${inner}</button>`;
}
function refreshAddButtons() {
  document.querySelectorAll("[data-cadd]").forEach((b) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = addBtn(b.dataset.cadd);
    const n = tmp.firstElementChild;
    if (n.className !== b.className) b.replaceWith(n);
  });
}

const catLists = new Map(); // list key -> catalogue tracks (what "play" means on that page)
function trackRow(t, rank, list = "") {
  const on = String(t.id) === String(pvId) && !pv.paused;
  const cur = String(player.song?.deezer_id || "") === String(t.id);
  const playing = cur && player.playing;
  return `<li class="row crow ${on ? "previewing" : ""} ${cur ? "current" : ""} ${playing ? "playing" : ""}" data-ctrack="${t.id}">
    ${rank ? `<span class="rank ${rank <= 3 ? "hot" : ""}">${rank}</span>` : ""}
    <button class="cart" data-cplay="${t.id}" data-clist="${list}" aria-label="Play">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : ""}<span class="pv">${playing ? `<span class="eq"><i></i><i></i><i></i></span>` : icon(on ? "pause" : "play")}</span></button>
    <span class="row-text" data-cplay="${t.id}" data-clist="${list}"><span class="row-title">${t.explicit ? `<span class="ex">E</span>` : ""}${esc(t.title)}</span>
      <span class="row-sub"><span class="a">${esc(t.artist || "")}</span>${t.duration ? `<i class="sep"></i><span class="t">${fmt(t.duration)}</span>` : ""}</span></span>
    ${addBtn(t.id)}
  </li>`;
}
const artistCircle = (a) =>
  `<button class="acircle" data-artist="${a.id}"><span class="ph">${a.picture ? `<img src="${esc(a.picture)}" alt="" loading="lazy">` : ""}</span><b>${esc(a.name)}</b></button>`;
const albumCard = (al, showArtist = true) =>
  `<button class="acard" data-album="${al.id}"><span class="cv">${al.cover ? `<img src="${esc(al.cover)}" alt="" loading="lazy">` : ""}</span><b>${esc(al.title)}</b>
    <small>${esc([showArtist ? al.artist : null, al.year, al.type === "single" ? "Single" : al.type === "ep" ? "EP" : null].filter(Boolean).join(" · "))}</small></button>`;

const playlistCard = (pl) =>
  `<button class="acard" data-dzpl="${pl.id}"><span class="cv">${pl.cover ? `<img src="${esc(pl.cover)}" alt="" loading="lazy">` : ""}</span><b>${esc(pl.title)}</b>
    <small>${esc([pl.tracks ? plural(pl.tracks) : null, pl.by && pl.by !== "anonymous" ? pl.by : null].filter(Boolean).join(" · "))}</small></button>`;

// mood tiles → playlists people made on Deezer
const MOODS = [
  ["Moroccan rap", "rap marocain", ""], ["Chaabi", "chaabi marocain", "sun"], ["Gnawa", "gnawa", "mint"],
  ["Raï", "rai", "rose"], ["Chill", "chill", "mint"], ["Lofi", "lofi", ""], ["Workout", "workout", "sun"],
  ["Love", "love songs", "rose"], ["Afro", "afrobeats", ""], ["Classic tarab", "oum kalthoum", "sun"],
  ["Trap", "trap", "rose"], ["Andalous", "andalou", "mint"],
];
const moodTiles = () =>
  `<div class="moods">${MOODS.map(([label, q, c]) => `<button class="mood ${c}" data-mood="${esc(q)}" data-label="${esc(label)}"><b>${esc(label)}</b></button>`).join("")}</div>`;

/* ---- previews (30 s from the catalogue) ---- */
function markPreview() {
  document.querySelectorAll(".crow").forEach((r) => {
    const on = r.dataset.ctrack === String(pvId) && !pv.paused;
    r.classList.toggle("previewing", on);
    const use = r.querySelector(".pv use");
    if (use) use.setAttribute("href", on ? "#i-pause" : "#i-play");
  });
}
function stopPreview(resume = true) {
  pv.pause();
  pvId = null;
  markPreview();
  if (resume && pvResume && player.song && !player.playing) player.toggle();
  pvResume = false;
}
function togglePreview(id) {
  const t = catTracks.get(String(id));
  if (!t?.preview) return toast("No preview for this song", true);
  if (String(pvId) === String(id) && !pv.paused) return stopPreview();
  if (player.playing) {
    player.toggle();
    pvResume = true;
  }
  pvId = String(id);
  pv.src = t.preview;
  pv.play().catch((err) => {
    if (err?.name !== "AbortError") toast("Preview failed", true);
  });
  markPreview();
}
pv.addEventListener("timeupdate", () => {
  const r = pvId && document.querySelector(`.crow[data-ctrack="${pvId}"]`);
  if (r) r.style.setProperty("--p", String(Math.min(1, pv.currentTime / (pv.duration || 30))));
});
pv.addEventListener("ended", () => stopPreview());
pv.addEventListener("play", markPreview);
pv.addEventListener("pause", markPreview);

/* ---- listening online (no download) ---- */
function warm(tracks, n, pcN = 0) {
  if (navigator.onLine === false) return;
  const songs = tracks.slice(0, n).map(streamSong);
  resolveVideos(songs)
    .catch(() => {})
    .then(() => {
      // the PC starts fetching the first songs right away, so pressing play is instant and ad-free
      if (pcN && workerOnline()) songs.filter((x) => x.stream).slice(0, pcN).forEach((x) => quickAudio(x, 300000, 1).catch(() => {}));
    });
}
function playOnline(listKey, trackId) {
  if (navigator.onLine === false) return toast("You need internet to listen online", true);
  const tracks = catLists.get(listKey) || [catTracks.get(String(trackId))].filter(Boolean);
  if (!tracks.length) return;
  const songs = tracks.map(streamSong);
  const i = Math.max(0, tracks.findIndex((t) => String(t.id) === String(trackId)));
  stopPreview(false);
  haptic();
  player.playList(songs.map((x) => x.id), trackId == null ? 0 : i);
  resolveVideos(songs.slice(i, i + 15)).catch(() => {});
}
const trackFromSong = (s) => ({
  id: s.deezer_id, title: s.title, version: s.version, artist: s.artist, album: s.album,
  cover: s.cover_small || s.cover_url, cover_xl: s.cover_url, duration: s.duration,
});

/* ---- adding ---- */
async function addTracks(tracks, playlistName = null) {
  if (navigator.onLine === false) return toast("You need internet to add songs", true);
  if (!tracks?.length) return;
  try {
    let pl = null;
    if (playlistName) pl = state.playlists.find((p) => p.name.toLowerCase() === playlistName.toLowerCase()) || (await createPlaylist(playlistName));
    const { queued, had } = await addCatalogTracks(tracks, pl);
    haptic();
    const pc = workerOnline() ? "your PC is downloading" : "downloads when your PC is on";
    if (tracks.length === 1) toast(queued ? `Added · ${pc}` : "Already in your library");
    else toast(queued ? `${queued} songs added${pl ? " to " + pl.name : ""} · ${pc}` : had ? "All already in your library" : "All already in the queue");
    refreshAddButtons();
  } catch (e) {
    toast(e.message || "Couldn't add", true);
  }
}

/* ---- search tab ---- */
function renderSearch() {
  const tab = $("#tab-search");
  if (tab.querySelector(".view")) return;
  tab.innerHTML = `<div class="view" id="search-view">
    <h1 class="page-title">Search</h1>
    <div class="search-top"><label class="searchbar">${icon("search")}<input id="sq" type="search" placeholder="Artists, songs or albums" autocomplete="off" autocapitalize="off" enterkeyhint="search"><span id="sq-state"></span></label>
      <div class="suggest" id="suggest" hidden></div></div>
    <div id="search-body"></div>
  </div>`;
  const input = $("#sq");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    renderSqState(q);
    if (q) suggestTimer = setTimeout(() => runSuggest(q), 160);
    else hideSuggest();
    searchTimer = setTimeout(() => runSearch(q), q ? 700 : 0);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      pushRecent(input.value);
      hideSuggest();
      clearTimeout(searchTimer);
      runSearch(input.value.trim());
      input.blur();
    }
    if (e.key === "Escape") hideSuggest();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim() && lastSuggest?.q === input.value.trim()) $("#suggest").hidden = false;
  });
  input.addEventListener("blur", () => setTimeout(hideSuggest, 180));
  renderSearchHome();
}

/* ---- suggestions while typing ---- */
let suggestTimer = null, suggestSeq = 0, lastSuggest = null;
function hideSuggest() {
  const el = $("#suggest");
  if (el) el.hidden = true;
}
async function runSuggest(q) {
  const seq = ++suggestSeq;
  let d;
  try {
    d = await catalog({ type: "suggest", q });
  } catch {
    return;
  }
  if (seq !== suggestSeq || $("#sq")?.value.trim() !== q) return;
  lastSuggest = { q, ...d };
  remember(d.tracks);
  catLists.set("sg", d.tracks);
  const el = $("#suggest");
  const hi = (txt) => {
    const t = esc(txt || "");
    const i = t.toLowerCase().indexOf(esc(q).toLowerCase());
    return i < 0 ? t : `${t.slice(0, i)}<mark>${t.slice(i, i + esc(q).length)}</mark>${t.slice(i + esc(q).length)}`;
  };
  el.innerHTML = `<button class="sg-row sg-query" data-sg-query="${esc(q)}"><span class="sg-ico">${icon("search")}</span><span class="sg-text"><b>Search “${esc(q)}”</b></span></button>
    ${d.artists.map((a) => `<button class="sg-row" data-artist="${a.id}"><span class="sg-img round-img">${a.picture ? `<img src="${esc(a.picture)}" alt="">` : ""}</span><span class="sg-text"><b>${hi(a.name)}</b><small>Artist</small></span></button>`).join("")}
    ${d.tracks.map((t) => `<button class="sg-row" data-cplay="${t.id}" data-clist="sg"><span class="sg-img">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ""}</span><span class="sg-text"><b>${hi(t.title)}</b><small>Song · ${esc(t.artist || "")}</small></span><span class="sg-play">${icon("play")}</span></button>`).join("")}
    ${d.albums.map((a) => `<button class="sg-row" data-album="${a.id}"><span class="sg-img">${a.cover ? `<img src="${esc(a.cover)}" alt="">` : ""}</span><span class="sg-text"><b>${hi(a.title)}</b><small>Album · ${esc(a.artist || "")}</small></span></button>`).join("")}`;
  el.hidden = false;
  warm(d.tracks, 3);
}

function renderSqState(q, loading = false) {
  const el = $("#sq-state");
  if (!el) return;
  el.innerHTML = loading ? `<span class="spin"></span>` : q ? `<button type="button" class="clear" data-sq-clear aria-label="Remove">${icon("x")}</button>` : "";
}

async function renderSearchHome() {
  const body = $("#search-body");
  if (!body) return;
  const rec = recentList();
  const recentHtml = rec.length
    ? `<div class="section-h"><h2>Recent searches</h2><button data-recent-clear>Clear</button></div>
       <div class="recent">${rec.map((q) => `<button class="chip" data-recent="${esc(q)}">${esc(q)}</button>`).join("")}</div>`
    : "";
  if (navigator.onLine === false) {
    body.innerHTML = recentHtml + `<div class="empty"><h3>No internet</h3><p>Search needs internet. Music saved on your phone still plays from "Songs".</p></div>`;
    return;
  }
  if (!chartData) body.innerHTML = recentHtml + `<div class="empty"><span class="spin" style="display:inline-block;width:26px;height:26px"></span></div>`;
  try {
    chartData = chartData || (await catalog({ type: "chart" }));
  } catch {
    body.innerHTML = recentHtml + `<div class="empty"><p>Couldn't load trending right now. Type a name above.</p></div>`;
    return;
  }
  if ($("#sq")?.value.trim()) return;
  remember(chartData.tracks);
  catLists.set("chart", chartData.tracks);
  warm(chartData.tracks, 10);
  body.innerHTML = `${recentHtml}
    <div class="section-h"><h2>Playlists by mood</h2></div>
    ${moodTiles()}
    <div class="section-h"><h2>Trending artists</h2></div>
    <div class="circles">${chartData.artists.map(artistCircle).join("")}</div>
    <div class="section-h"><h2>Top 20 right now</h2><button data-cadd-list="chart">Add all</button></div>
    <ul class="list">${chartData.tracks.map((t, i) => trackRow(t, i + 1, "chart")).join("")}</ul>
    <div style="height:22px"></div>
    ${chartData.playlists?.length ? `<div class="section-h"><h2>Trending playlists</h2></div>
      <div class="albums">${chartData.playlists.map(playlistCard).join("")}</div>` : ""}
    <div class="section-h"><h2>New albums</h2></div>
    <div class="albums">${chartData.albums.map((a) => albumCard(a)).join("")}</div>`;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  showAllTracks = false;
  if (!q) {
    renderSqState("");
    lastResults = null;
    return renderSearchHome();
  }
  if (navigator.onLine === false) return renderSearchHome();
  renderSqState(q, true);
  try {
    const data = await catalog({ type: "search", q });
    if (seq !== searchSeq) return;
    lastResults = { q, ...data };
    remember(data.tracks);
    renderResults();
  } catch (e) {
    if (seq === searchSeq) $("#search-body").innerHTML = `<div class="empty"><p>${esc(e.message || "Something went wrong")}</p></div>`;
  } finally {
    if (seq === searchSeq) renderSqState(q);
  }
}

function renderResults() {
  const r = lastResults, body = $("#search-body");
  if (!r || !body) return;
  if (!r.artists.length && !r.tracks.length && !r.albums.length && !r.playlists?.length) {
    body.innerHTML = `<div class="empty"><h3>Nothing found</h3><p>Try another spelling, like "Nass El Ghiwane" or "Saad Lamjarred".</p></div>`;
    return;
  }
  const tracks = showAllTracks ? r.tracks : r.tracks.slice(0, 8);
  catLists.set("res", r.tracks);
  warm(r.tracks, 8);
  body.innerHTML = `
    ${r.artists.length ? `<div class="section-h"><h2>Artists</h2></div><div class="circles">${r.artists.map(artistCircle).join("")}</div>` : ""}
    ${r.tracks.length ? `<div class="section-h"><h2>Songs</h2></div><ul class="list">${tracks.map((t) => trackRow(t, 0, "res")).join("")}</ul>
      ${!showAllTracks && r.tracks.length > 8 ? `<button class="more-link" data-show-all>See all (${r.tracks.length})</button>` : `<div style="height:22px"></div>`}` : ""}
    ${r.playlists?.length ? `<div class="section-h"><h2>Playlists</h2></div><div class="albums">${r.playlists.map(playlistCard).join("")}</div>` : ""}
    ${r.albums.length ? `<div class="section-h"><h2>Albums</h2></div><div class="albums">${r.albums.map((a) => albumCard(a)).join("")}</div>` : ""}`;
}

function fmtFans(n) {
  if (!n) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "") + "M fans";
  if (n >= 1e3) return Math.round(n / 1e3) + "K fans";
  return n + " fans";
}

function openArtist(id) {
  stopPreview(false);
  pushView("search", async (v) => {
    v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><span class="spin" style="display:inline-block;width:26px;height:26px"></span></div>`;
    try {
      const d = artistData.get(id) || (await catalog({ type: "artist", id }));
      artistData.set(id, d);
      remember(d.top);
      catLists.set("ar:" + id, d.top);
      warm(d.top, 20, 2);
      const a = d.artist;
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button><span class="grow"></span></div>
        <div class="c-hero">
          ${a.picture_xl ? `<img class="halo" src="${esc(a.picture_xl)}" alt="">` : ""}
          <div class="face">${a.picture_xl ? `<img src="${esc(a.picture_xl)}" alt="">` : ""}</div>
          <h1>${esc(a.name)}</h1>
          <p>${esc([fmtFans(a.fans), a.albums ? a.albums + " albums" : null].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="c-actions">
          ${d.top.length ? `<button class="btn btn-lav" data-ctop-add="${id}">${icon("plus")}Add top 10</button>
          <button class="btn btn-dark" data-cplayall="ar:${id}">${icon("play")}Play</button>` : ""}
        </div>
        ${d.top.length ? `<div class="section-h"><h2>Top songs</h2></div><ul class="list">${d.top.slice(0, 10).map((t, i) => trackRow(t, i + 1, "ar:" + id)).join("")}</ul>
          ${d.top.length > 10 ? `<button class="more-link" data-artist-more="${id}">Show ${d.top.length - 10} more</button>` : `<div style="height:22px"></div>`}` : ""}
        ${d.albums.length ? `<div class="section-h"><h2>Albums & singles</h2></div><div class="albums">${d.albums.map((al) => albumCard(al, false)).join("")}</div>` : ""}
        ${d.related.length ? `<div class="section-h"><h2>Fans also like</h2></div><div class="circles">${d.related.map(artistCircle).join("")}</div>` : ""}`;
    } catch (e) {
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><p>${esc(e.message || "Couldn't load")}</p></div>`;
    }
  });
}

const dzPlaylists = new Map();
function openDzPlaylist(id) {
  stopPreview(false);
  pushView("search", async (v) => {
    v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><span class="spin" style="display:inline-block;width:26px;height:26px"></span></div>`;
    try {
      const d = dzPlaylists.get(id) || (await catalog({ type: "playlist", id }));
      dzPlaylists.set(id, d);
      remember(d.tracks);
      catLists.set("dz:" + id, d.tracks);
      warm(d.tracks, 30, 2);
      const pl = d.playlist;
      const mins = pl.duration ? Math.round(pl.duration / 60) : null;
      const more = pl.tracks && pl.tracks > d.tracks.length;
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button><span class="grow"></span></div>
        <div class="c-hero">
          ${pl.cover_xl ? `<img class="halo" src="${esc(pl.cover_xl)}" alt="">` : ""}
          <div class="face sq">${pl.cover_xl ? `<img src="${esc(pl.cover_xl)}" alt="">` : ""}</div>
          <h1>${esc(pl.title)}</h1>
          ${pl.by && pl.by !== "anonymous" ? `<span class="by">${esc(pl.by)}</span>` : ""}
          <p>${esc([pl.tracks ? plural(pl.tracks) : null, mins ? (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}min` : `${mins} min`) : null, pl.fans ? fmtFans(pl.fans) : null].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="c-actions">
          ${d.tracks.length ? `<button class="btn btn-lav" data-dzpl-add="${id}">${icon("plus")}${more ? `Add first ${d.tracks.length}` : "Add whole playlist"}</button>
          <button class="btn btn-dark" data-cplayall="dz:${id}">${icon("play")}Play</button>` : ""}
        </div>
        ${d.tracks.length ? `<ul class="list">${d.tracks.map((t) => trackRow(t, t.position, "dz:" + id)).join("")}</ul>` : `<div class="empty"><p>This playlist is empty.</p></div>`}`;
    } catch (e) {
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><p>${esc(e.message || "Couldn't load")}</p></div>`;
    }
  });
}

function openMood(q, label) {
  stopPreview(false);
  pushView("search", async (v) => {
    v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div>
      <h1 class="page-title">${esc(label)}</h1><div class="empty"><span class="spin" style="display:inline-block;width:26px;height:26px"></span></div>`;
    try {
      const d = await catalog({ type: "playlists", q });
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div>
        <h1 class="page-title">${esc(label)}</h1>
        <p class="sync-line" style="margin-top:-10px">${d.playlists.length} playlists made by listeners</p>
        ${d.playlists.length ? `<div class="pgrid">${d.playlists.map(playlistCard).join("")}</div>` : `<div class="empty"><p>Nothing found.</p></div>`}`;
    } catch (e) {
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><p>${esc(e.message || "Couldn't load")}</p></div>`;
    }
  });
}

function openAlbum(id) {
  stopPreview(false);
  pushView("search", async (v) => {
    v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><span class="spin" style="display:inline-block;width:26px;height:26px"></span></div>`;
    try {
      const d = albumData.get(id) || (await catalog({ type: "album", id }));
      albumData.set(id, d);
      remember(d.tracks);
      catLists.set("al:" + id, d.tracks);
      warm(d.tracks, 30, 2);
      const al = d.album;
      const mins = al.duration ? Math.round(al.duration / 60) + " min" : null;
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button><span class="grow"></span></div>
        <div class="c-hero">
          ${al.cover_xl ? `<img class="halo" src="${esc(al.cover_xl)}" alt="">` : ""}
          <div class="face sq">${al.cover_xl ? `<img src="${esc(al.cover_xl)}" alt="">` : ""}</div>
          <h1>${esc(al.title)}</h1>
          ${al.artist ? `<button class="by" data-artist="${al.artist_id}">${esc(al.artist)}</button>` : ""}
          <p>${esc([al.year, plural(d.tracks.length), mins].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="c-actions">
          <button class="btn btn-lav" data-calbum-add="${id}">${icon("plus")}Add whole album</button>
          ${d.tracks[0] ? `<button class="btn btn-dark" data-cplayall="al:${id}">${icon("play")}Play</button>` : ""}
        </div>
        <ul class="list">${d.tracks.map((t) => trackRow(t, t.position, "al:" + id)).join("")}</ul>
        ${al.label ? `<p class="group-note" style="margin-top:18px">© ${esc(al.label)}</p>` : ""}`;
    } catch (e) {
      v.innerHTML = `<div class="topbar"><button class="round" data-back="search" aria-label="Back">${icon("chev-left")}</button></div><div class="empty"><p>${esc(e.message || "Couldn't load")}</p></div>`;
    }
  });
}

async function handleSearchClick(e) {
  const el = (sel) => e.target.closest(sel);
  let b;
  if (el("#suggest")) setTimeout(hideSuggest, 0);
  if ((b = el("[data-sg-query]"))) {
    pushRecent(b.dataset.sgQuery);
    clearTimeout(searchTimer);
    runSearch(b.dataset.sgQuery);
    $("#sq").blur();
    return true;
  }
  if ((b = el("[data-cadd]"))) {
    const id = b.dataset.cadd, st = catalogStatus(Number(id));
    if (st === "have") {
      const s = songForDeezer(Number(id));
      if (s) await player.playList([s.id], 0);
      return true;
    }
    if (st === "queued") return toast("Already queued, downloading"), true;
    const t = catTracks.get(id);
    if (t) await addTracks([t]);
    return true;
  }
  if ((b = el("[data-cplay]"))) {
    const cur = String(player.song?.deezer_id || "") === b.dataset.cplay;
    if (cur) return player.toggle(), true;
    return playOnline(b.dataset.clist, b.dataset.cplay), true;
  }
  if ((b = el("[data-cplayall]"))) return playOnline(b.dataset.cplayall, null), true;
  if ((b = el("[data-preview]"))) return togglePreview(b.dataset.preview), true;
  if ((b = el("[data-artist]"))) {
    const q = $("#sq")?.value.trim();
    if (q) pushRecent(q);
    if (currentTab !== "search") showTab("search");
    return openArtist(b.dataset.artist), true;
  }
  if ((b = el("[data-dzpl]"))) {
    const q = $("#sq")?.value.trim();
    if (q) pushRecent(q);
    return openDzPlaylist(b.dataset.dzpl), true;
  }
  if ((b = el("[data-mood]"))) return openMood(b.dataset.mood, b.dataset.label), true;
  if ((b = el("[data-dzpl-add]"))) {
    const d = dzPlaylists.get(b.dataset.dzplAdd);
    if (d) await addTracks(d.tracks, d.playlist.title);
    return true;
  }
  if ((b = el("[data-album]"))) {
    const q = $("#sq")?.value.trim();
    if (q) pushRecent(q);
    return openAlbum(b.dataset.album), true;
  }
  if ((b = el("[data-ctop-add]"))) {
    const d = artistData.get(b.dataset.ctopAdd);
    if (d) await addTracks(d.top.slice(0, 10), d.artist.name);
    return true;
  }
  if ((b = el("[data-calbum-add]"))) {
    const d = albumData.get(b.dataset.calbumAdd);
    if (d) await addTracks(d.tracks, d.album.title);
    return true;
  }
  if ((b = el("[data-cadd-list]"))) {
    if (chartData) await addTracks(chartData.tracks, "Top 20");
    return true;
  }
  if ((b = el("[data-artist-more]"))) {
    const d = artistData.get(b.dataset.artistMore);
    const list = b.previousElementSibling;
    if (d && list) {
      list.innerHTML = d.top.map((t, i) => trackRow(t, i + 1, "ar:" + b.dataset.artistMore)).join("");
      b.remove();
    }
    return true;
  }
  if (el("[data-show-all]")) { showAllTracks = true; renderResults(); return true; }
  if ((b = el("[data-recent]"))) {
    const input = $("#sq");
    input.value = b.dataset.recent;
    runSearch(b.dataset.recent);
    return true;
  }
  if (el("[data-recent-clear]")) {
    try { localStorage.removeItem("tarab-recent"); } catch {}
    renderSearchHome();
    return true;
  }
  if (el("[data-sq-clear]")) {
    e.preventDefault();
    hideSuggest();
    $("#sq").value = "";
    runSearch("");
    return true;
  }
  return false;
}

/* ================= global clicks ================= */
document.addEventListener("click", async (e) => {
  if (pressed) { pressed = false; e.preventDefault(); return; }
  player.unlock();
  const el = (sel) => e.target.closest(sel);
  let b;
  if (e.target.closest("#tab-search") && (await handleSearchClick(e))) return;

  if ((b = el("[data-go]"))) return showTab(b.dataset.go);
  if ((b = el("[data-back]"))) return popView(b.dataset.back);
  if ((b = el("[data-more]"))) return songMenu(b.dataset.more, b.dataset.ctx);
  if ((b = el("[data-qrm]"))) { player.removeFromQueue(+b.dataset.qrm); return renderQueue(); }
  if ((b = el("[data-qi]"))) return player.playIndex(+b.dataset.qi);
  if ((b = el("[data-playall]"))) { const ids = listCtx.get(b.dataset.playall) || []; if (ids.length) player.playList(ids, 0); return; }
  if ((b = el("[data-shuffleall]"))) { const ids = listCtx.get(b.dataset.shuffleall) || []; if (ids.length) player.playList(ids, -1, { shuffle: true }); return; }
  if ((b = el("[data-plmore]"))) return playlistMenu(b.dataset.plmore);
  if ((b = el("[data-pladd]"))) return addLinkTo(b.dataset.pladd);
  if ((b = el("[data-rplay]"))) {
    if (player.song?.id === b.dataset.rplay) return player.toggle();
    return playFrom(b.dataset.ctx, b.dataset.rplay);
  }
  if ((b = el("[data-song]"))) {
    if (player.song?.id === b.dataset.song && !b.closest(".job")) return openNP();
    return playFrom(b.dataset.ctx, b.dataset.song);
  }
  if ((b = el("[data-openpl]"))) return openPlaylist(b.dataset.openpl);
  if (el("[data-newpl]")) {
    const n = await promptSheet("Playlist name", "", "Sawb");
    if (n) { try { const pl = await createPlaylist(n); openPlaylist(pl.id); } catch (err) { toast(err.message, true); } }
    return;
  }
  if (el("[data-search]")) {
    const bar = $("#searchbar");
    bar.hidden = false;
    $("#hero").hidden = true;
    $("#q").focus();
    return;
  }
  if (el("[data-search-close]")) {
    e.preventDefault();
    $("#searchbar").hidden = true;
    $("#hero").hidden = false;
    $("#q").value = "";
    query = "";
    return renderHomeBody();
  }
  if (el("[data-go-cloud]")) {
    showTab("settings");
    return setTimeout(() => $("#cloud-box")?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }
  if (el("[data-profile]")) return profileMenu();
  if (el("[data-open-np]")) return npOpen ? closeNP() : openNP();
  if (el("[data-open-lyrics]")) return lyOpen && npOpen ? closeLyrics() : openLyrics();
  if ((b = el(".ly-line[data-lt]"))) {
    lyFreeUntil = 0;
    player.seek(Number(b.dataset.lt));
    if (!player.playing) player.toggle();
    return setTimeout(() => syncLyrics(true), 120);
  }
  if (el("[data-ly-retry]")) return renderLyrics(true, true);
  if (el("[data-open-queue]")) {
    if (!npOpen) openNP();
    $("#np-queue").hidden = false;
    return renderQueue();
  }
  if (el("[data-mute]")) {
    const v = player.settings.volume ?? 1;
    if (v > 0) { lastVolume = v; player.setVolume(0); } else player.setVolume(lastVolume || 1);
    return updateVolumeUI();
  }
  if (el("#sb-install")) {
    if (!installEvt) return toast("In Chrome/Edge: menu ⋮ → Install Tarab", false);
    installEvt.prompt();
    return;
  }
  if (el("[data-copy-yml]")) {
    try {
      const yml = await (await fetch("pc/tarab.yml", { cache: "no-store" })).text();
      await navigator.clipboard.writeText(yml);
      toast("tarab.yml copied ✓");
    } catch {
      toast("Couldn't copy. Open pc/tarab.yml on the site", true);
    }
    return;
  }
  if (el("[data-cloud-test]")) {
    toast("Starting the cloud…");
    const r = await kickCloud(true).catch((err) => ({ status: "error", error: err.message }));
    if (r.status === "started") toast("Cloud started ✓ · see GitHub → Actions");
    else if (r.status === "not_configured") toast("Fill in repo and token first", true);
    else toast(r.error || "Didn't start", true);
    loadUserSettings().then(fillCloud).catch(() => {});
    return;
  }
  if (el("[data-upload]")) return pickUpload();
  if ((b = el("[data-jlink]"))) {
    const job = state.jobs.find((j) => j.id === b.dataset.jlink);
    if (!job) return;
    const url = await promptSheet("Link for this song", "", "Add", "YouTube, SoundCloud…");
    if (url) {
      try {
        await retryWithLink(job, url);
        toast("Added. Your PC will download it from this link");
      } catch (err) {
        toast(err.message || "Couldn't add", true);
      }
    }
    return;
  }
  if (el("[data-profile-photo]")) return pickAvatar();
  if (el("[data-rename]")) {
    const n = await promptSheet("What's your name?", displayName(), "Save");
    if (n) {
      try { localStorage.setItem("tarab-name", n); } catch {}
      renderHomeShell();
      if (currentTab === "settings") renderSettings();
    }
    return;
  }
  if ((b = el("[data-retry]"))) return retryJob(b.dataset.retry);
  if ((b = el("[data-deljob]"))) return deleteJob(b.dataset.deljob);
  if (el("[data-clearjobs]")) return clearFinishedJobs();
  if ((b = el("[data-copy]"))) {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch { toast("Couldn't copy", true); }
    return;
  }
  if (el("[data-clear-offline]")) {
    if (await confirmSheet("Remove music from this phone? It stays in your account.", "Remove")) {
      await clearAllAudio();
      refreshLists();
      renderSettings();
      toast("Phone storage freed");
    }
    return;
  }
  if (el("[data-signout]")) return doSignOut();

  if ((b = el(".mini-btn"))) {
    if (b.dataset.act === "toggle") player.toggle();
    else player.next();
    return;
  }
  if (el("#mini")) return openNP();

  if ((b = el("[data-np]"))) {
    const a = b.dataset.np;
    if (a === "close") closeNP();
    if (a === "toggle") player.toggle();
    if (a === "next") player.next();
    if (a === "prev") player.prev();
    if (a === "shuffle") player.toggleShuffle();
    if (a === "repeat") player.cycleRepeat();
    if (a === "automix") {
      player.setSettings({ automix: !player.settings.automix });
      toast(player.settings.automix ? `AutoMix on · ${player.settings.fade}s` : "AutoMix off");
      if (currentTab === "settings") renderSettings();
    }
    if (a === "lyrics") return lyOpen ? closeLyrics() : openLyrics();
    if (a === "queue") {
      const q = $("#np-queue");
      q.hidden = !q.hidden;
      if (!q.hidden) renderQueue();
    }
    if (a === "like" && player.song?.stream) {
      const s = player.song;
      if (!catalogStatus(s.deezer_id)) await addTracks([trackFromSong(s)]);
      else toast(catalogStatus(s.deezer_id) === "have" ? "Already in your library" : "Already downloading");
      updateNP();
      updateDeskbar();
      return;
    }
    if (a === "like" && player.song) {
      const s = player.song;
      await setLiked(s, !s.liked).catch(() => toast("Couldn't save", true));
      b.classList.remove("pop");
      void b.offsetWidth;
      b.classList.add("pop");
      haptic();
      updateNP();
    }
    if (a === "more" && player.song) songMenu(player.song.id, null);
  }
});

$("#tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) { e.stopPropagation(); showTab(b.dataset.go); }
});

function refreshLists() {
  renderHomeBody();
  renderPlaylists();
  renderSync();
  renderSidebar();
}

/* ================= offline sync ================= */
let serverLoaded = false;
let syncTick = 0;
function maybeSync() {
  if (!player.settings.autoOffline || !state.songs.length) return;
  syncOffline(() => state.songs, () => {
    renderSync();
    // re-render the lists now and then so the cloud marks disappear
    if (++syncTick % 3 === 0 || !syncState.running) {
      renderHomeBody();
      renderJobs();
    }
  });
}
window.addEventListener("online", () => { renderSync(); maybeSync(); refreshAll().catch(() => {}); });
window.addEventListener("offline", renderSync);

/* iPhone: the keyboard can leave the page scrolled, which pushes the bottom bar out of place */
(() => {
  const reset = () => {
    if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = document.body.scrollTop = 0;
    }
  };
  const vv = window.visualViewport;
  const check = () => {
    const open = !!vv && vv.height < window.innerHeight * 0.78 && !!document.activeElement?.matches?.("input, textarea, select");
    document.body.classList.toggle("kb-open", open);
    if (!open) reset();
  };
  vv?.addEventListener("resize", check);
  vv?.addEventListener("scroll", () => !document.body.classList.contains("kb-open") && reset());
  document.addEventListener("focusout", () => setTimeout(check, 80));
  document.addEventListener("focusin", () => setTimeout(check, 300));
  window.addEventListener("pageshow", reset);
  window.addEventListener("orientationchange", () => setTimeout(reset, 300));
  document.addEventListener("visibilitychange", () => !document.hidden && setTimeout(reset, 50));
})();

/* old address: point people to the new home */
if (/netlify\.app$/.test(location.hostname)) {
  const NEW_HOME = "https://dev-king777.github.io/tarab-cloud/";
  setTimeout(() => {
    const d = document.createElement("a");
    d.href = NEW_HOME;
    d.className = "moved";
    d.innerHTML = `<b>Tarab moved</b><span>Open the new link, sign in, and add it to your Home Screen again →</span>`;
    document.getElementById("shell")?.prepend(d);
  }, 600);
}

/* ================= player events ================= */
let raf = 0;
player.resolver = (song) => resolveVideos([song]);
// online songs: the PC fetches the audio (no ads, works with the screen locked); YouTube only if the PC is off
// 10 = playing now (the PC does it first), 5 = up next, 4 = the one after, 1 = prefetch from a page
player.audioResolver = (song, prio = 10) => quickAudio(song, prio >= 10 ? 60000 : 180000, prio);
player.audioReady = (song) => quickReady(song);
player.partResolver = (song, prio = 10) => quickPart(song, prio);
if (location.hostname === "127.0.0.1") window.__player = player; // tests only
let ytNoticeShown = false;
let lastQuickSong = null;
function warmAhead() {
  const cur = player.song;
  if (cur && cur.id !== lastQuickSong) {
    lastQuickSong = cur.id;
    const ids = [0, 1, 2].map((d) => songById(player.queue[player.index + d])?.deezer_id);
    cancelQuickExcept(ids);
  }
  // the song after next too, so the queue keeps going with the phone locked
  const s2 = songById(player.queue[player.index + 2]);
  if (s2?.stream && workerOnline()) quickAudio(s2, 180000, 4).catch(() => {});
}
player.addEventListener("change", (e) => {
  const type = e.detail;
  if (type === "time") {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(updateScrub);
    return;
  }
  if (type === "error")
    toast(navigator.onLine === false ? "This song isn't saved on the phone yet" : "Couldn't play this song", true);
  if (type === "fade") return showMixState();
  if (type === "nostream") {
    const s = player.song;
    const pcOn = workerOnline();
    toast(pcOn ? "Couldn't get this song right now" : s?.preview ? "Your PC is off · playing a 30-second preview" : "Turn on your PC to listen online", !pcOn ? false : true);
    if (s?.preview) togglePreview(String(s.deezer_id));
  }
  if (type === "streamerror") {
    toast("YouTube won't play this one, skipping to the next", true);
    setTimeout(() => player.next(), 900);
  }
  if (type === "quick") {
    const id = player.song?.id;
    setTimeout(() => player.loading && player.song?.id === id && toast("Getting it from your PC…"), 1200);
  }
  if (type === "stream" && !ytNoticeShown && !workerOnline()) {
    ytNoticeShown = true;
    setTimeout(() => toast("Your PC is off, so this plays from YouTube (it may show ads)"), 3200);
  }
  if (type === "stream") {
    const id = player.song?.id;
    // iPhone sometimes wants one tap on the video itself before sound can start
    setTimeout(() => {
      if (player.streaming && player.song?.id === id && !player.playing && player.yt.state !== 2 && !workerOnline()) {
        if (!npOpen) openNP();
        np.classList.add("needs-tap");
        toast("Tap the cover to start");
      } else if (player.streaming && player.song?.id === id && !player.playing && workerOnline()) {
        toast("Getting it from your PC · no ads");
      }
    }, 2600);
  }
  if (!player.fading) showMixState();
  if (player.playing && !pv.paused) stopPreview(false);
  if (type === "volume") return updateVolumeUI();
  updateMini();
  updateDeskbar();
  markRows();
  if (npOpen) updateNP();
  if (lyOpen) renderLyrics();
  prefetchLyrics();
  if (type === "state") warmAhead();
  publishNP();
});

/* ================= data events ================= */
onChange((what) => {
  if (what === "library") {
    refreshLists();
    if (npOpen) updateNP();
    updateMini();
    updateDeskbar();
    if (serverLoaded) pruneOffline(state.songs.map((s) => s.id));
    refreshAddButtons();
    maybeSync();
  }
  if (what === "jobs") { renderJobs(); refreshAddButtons(); }
  if (what === "worker") { renderPcPill(); renderJobs(); }
  if (what === "settings") { renderPcPill(); renderJobs(); }
  if (what?.type === "song-added") toast(`Arrived: ${what.song.title}`);
});

/* ================= auth + boot ================= */
let createMode = false;
function showAuth() {
  $("#auth").hidden = false;
  $("#shell").hidden = true;
  const sw = $("#auth-switch");
  sw.onclick = () => {
    createMode = !createMode;
    $("#auth-submit").textContent = createMode ? "Create account" : "Sign in";
    sw.textContent = createMode ? "I already have an account" : "First time? Create an account";
    $("#auth-pass").autocomplete = createMode ? "new-password" : "current-password";
    $("#auth-err").textContent = "";
  };
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim(), pass = $("#auth-pass").value;
    const btn = $("#auth-submit");
    btn.disabled = true;
    $("#auth-err").textContent = "";
    try {
      if (createMode) await createAccount(email, pass);
      else await signIn(email, pass);
      $("#auth").hidden = true;
      await startApp();
    } catch (err) {
      $("#auth-err").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}

async function startApp() {
  $("#shell").hidden = false;
  await scanOffline();
  renderHomeShell();
  renderPlaylists();
  player.restoreSession();
  updateMini();
  requestPersist();
  try {
    await refreshAll(); // emits "library" → prune + sync
    serverLoaded = true;
    pruneOffline(state.songs.map((s) => s.id));
    player.restoreSession();
    updateMini();
  } catch {
    if (!state.songs.length) toast("No internet", true);
  }
  maybeSync();
  renderSidebar();
  updateDeskbar();
  loadUserSettings().then(() => { renderPcPill(); renderJobs(); }).catch(() => {});
  Promise.all([refreshJobs(), refreshWorker()]).then(() => {
    // downloads wait for the PC
  }).catch(() => {});
  startRealtime();
  setInterval(renderPcPill, 20000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.user) {
      Promise.all([refreshJobs(), refreshWorker()]).then(() => {
        // downloads wait for the PC
      }).catch(() => {});
      refreshAll().catch(() => {});
    }
  });
  try {
    if (state.songs.length && !localStorage.getItem("tarab-hint-press")) {
      setTimeout(() => toast("Long-press a song to see options"), 1500);
      localStorage.setItem("tarab-hint-press", "1");
    }
  } catch {}
}

async function boot() {
  bindScrub();
  bindNPDrag();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  loadLocal();
  let user = null;
  try { user = await currentUser(); } catch {}
  $("#boot").classList.add("out");
  if (!user) return showAuth();
  await startApp();
}

boot();
