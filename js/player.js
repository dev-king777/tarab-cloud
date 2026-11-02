// Two <audio> elements: one plays, the other holds the next track ready.
// That gives near-gapless changes, and with AutoMix on (Web Audio gains)
// the two overlap into a crossfade.
import { getAudioBlob, coverURLSync, getCoverURL } from "./media.js";
import { songById, bumpPlay } from "./data.js";

const SILENT =
  "data:audio/mp4;base64,AAAAHGZ0eXBNNEEgAAAAAE00QSBpc29tbXA0MgAAAAFtZGF0AAAAAAAAAAAAAAAA";
const SETTINGS_KEY = "tarab-settings-v1";
const SESSION_KEY = "tarab-session-v1";

function readSettings() {
  try {
    return { automix: false, fade: 6, autoOffline: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { automix: false, fade: 6, autoOffline: true };
  }
}

// Official YouTube player, used for songs streamed online (not downloaded).
class YTBridge {
  constructor() {
    this.p = null;
    this.ready = null;
    this.state = -1;
    this.onState = null;
    this.onError = null;
    this.volume = 1;
  }
  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const make = () => {
        const host = document.getElementById("yt-host");
        const mount = document.createElement("div");
        host.appendChild(mount);
        this.p = new window.YT.Player(mount, {
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0, modestbranding: 1, autoplay: 0, origin: location.origin },
          events: {
            onReady: () => {
              this.p.setVolume(Math.round(this.volume * 100));
              resolve(this.p);
            },
            onStateChange: (e) => {
              this.state = e.data;
              this.onState?.(e.data);
            },
            onError: (e) => this.onError?.(e.data),
          },
        });
      };
      if (window.YT?.Player) return make();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        make();
      };
      const sc = document.createElement("script");
      sc.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(sc);
    });
    return this.ready;
  }
  load(id, start = 0) {
    if (this.p?.loadVideoById) this.p.loadVideoById({ videoId: id, startSeconds: start });
    else this.init().then((p) => p.loadVideoById({ videoId: id, startSeconds: start }));
  }
  play() { this.p?.playVideo?.(); }
  pause() { this.p?.pauseVideo?.(); }
  seek(t) { this.p?.seekTo?.(t, true); }
  get time() { return this.p?.getCurrentTime?.() || 0; }
  get duration() { return this.p?.getDuration?.() || 0; }
  get playing() { return this.state === 1 || this.state === 3; }
  setVolume(v) {
    this.volume = v;
    this.p?.setVolume?.(Math.round(v * 100));
  }
}

// iPhone/iPad: Web Audio is paused when the app is in the background, which silences
// anything routed through it and breaks the lock screen controls. Plain <audio> only there.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

class Player extends EventTarget {
  constructor() {
    super();
    this.els = [new Audio(), new Audio()];
    this.urls = [null, null];
    this.ci = 0;
    this.queue = [];
    this.order = []; // un-shuffled copy
    this.index = -1;
    this.shuffle = false;
    this.repeat = "off"; // off | all | one
    this.nextId = null; // id loaded into the idle element
    this.fading = false;
    this.loading = false;
    this.ctx = null;
    this.gains = null;
    this.settings = readSettings();
    this.unlocked = false;
    this.mode = "audio"; // "audio" = library file, "yt" = streaming online
    this.resolver = null; // (song) => Promise, fills song.video_id
    this.audioResolver = null; // (song) => Promise<url|null>, ad-free audio fetched by the PC
    this.audioReady = null; // (song) => true when that audio is already fetched
    this.partResolver = null; // (song, prio) => Promise<{url, full}|null>, first playable piece
    this.partial = null; // { id, waiting } while only the first seconds are loaded
    this.yt = new YTBridge();
    this.yt.volume = this.settings.volume ?? 1;
    this.yt.onState = (st) => this.#onYTState(st);
    this.yt.onError = () => this.#emit("streamerror");
    setInterval(() => {
      if (this.mode === "yt" && this.yt.playing) {
        this.#emit("time");
        this.#positionState();
      }
    }, 500);
    this.els.forEach((el) => (el.volume = this.settings.volume ?? 1));

    for (const el of this.els) {
      el.preload = "auto";
      el.setAttribute("playsinline", "");
      el.addEventListener("ended", (e) => e.target === this.cur && this.mode === "audio" && this.#onEnded());
      el.addEventListener("timeupdate", (e) => e.target === this.cur && this.#onTime());
      el.addEventListener("play", (e) => e.target === this.cur && (this.#playState(), this.#emit()));
      el.addEventListener("pause", (e) => e.target === this.cur && !this.fading && (this.#playState(), this.#emit()));
      el.addEventListener("loadedmetadata", (e) => e.target === this.cur && this.#emit());
      el.addEventListener("error", (e) => {
        if (e.target === this.cur && this.cur.src && !this.cur.src.startsWith("data:")) this.#emit("error");
      });
    }

    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch {}
    this.#bindMediaSession();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
      this.#saveSession();
    });
  }

  get cur() {
    return this.els[this.ci];
  }
  get idle() {
    return this.els[1 - this.ci];
  }
  get song() {
    return songById(this.queue[this.index]);
  }
  get playing() {
    if (this.mode === "yt") return this.yt.playing;
    // the silent clip used to unlock audio on iOS doesn't count as playing
    return !this.cur.paused && !!this.cur.src && !this.cur.src.startsWith("data:");
  }
  get streaming() {
    return this.mode === "yt";
  }
  get time() {
    if (this.mode === "yt") return this.yt.time;
    return this.cur.currentTime || 0;
  }
  get duration() {
    if (this.mode === "yt") return this.yt.duration || this.song?.duration || 0;
    if (this.partial && this.song?.duration) return this.song.duration; // only the first seconds are loaded yet
    const d = this.cur.duration;
    return Number.isFinite(d) && d > 0 ? d : this.song?.duration || 0;
  }
  // Where AutoMix will start blending into the next song (seconds), or null.
  get mixPoint() {
    if (!this.settings.automix || !this.song || this.song.stream) return null;
    const end = this.song.outro && this.song.outro > 20 ? this.song.outro : this.duration;
    return end ? Math.max(0, end - this.settings.fade) : null;
  }

  /* ---------- iOS needs one tap before audio can start ---------- */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    for (const el of this.els) {
      if (el.src) continue;
      el.src = SILENT;
      el.play().then(() => el.pause()).catch(() => {});
    }
    if (this.settings.automix && !IOS) this.#buildGraph();
  }

  #buildGraph() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.gains = this.els.map((el) => {
        const src = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain();
        src.connect(g).connect(this.ctx.destination);
        return g;
      });
      this.gains[1 - this.ci].gain.value = 0;
      this.gains[this.ci].gain.value = this.#norm(this.song);
    } catch {
      this.ctx = null;
      this.gains = null;
    }
  }

  // desktop volume (iOS ignores element volume and uses the hardware buttons)
  setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    this.els.forEach((el) => (el.volume = v));
    this.yt.setVolume(v);
    this.settings.volume = v;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {}
    this.#emit("volume");
  }

  setSettings(patch) {
    Object.assign(this.settings, patch);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {}
    if (this.settings.automix && this.unlocked && !IOS) this.#buildGraph();
    this.#prepareNext();
    this.#emit();
  }

  /* ---------- queue control ---------- */
  async playList(ids, start = 0, { shuffle = false } = {}) {
    this.unlock();
    this.order = ids.slice();
    this.shuffle = shuffle;
    if (shuffle) {
      const first = start >= 0 ? ids[start] : ids[Math.floor(Math.random() * ids.length)];
      this.queue = [first, ...shuffled(ids.filter((x) => x !== first))];
      this.index = 0;
    } else {
      this.queue = ids.slice();
      this.index = Math.max(0, start);
    }
    await this.#loadCurrent(true);
  }

  async playIndex(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.#abortFade();
    this.index = i;
    await this.#loadCurrent(true);
  }

  playNext(id) {
    if (!this.queue.length) return this.playList([id], 0);
    this.queue = this.queue.filter((x, i) => x !== id || i === this.index);
    this.queue.splice(this.index + 1, 0, id);
    this.order.push(id);
    this.#prepareNext(true);
    this.#emit();
  }

  removeFromQueue(i) {
    if (i === this.index || i < 0) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this.#prepareNext(true);
    this.#emit();
  }

  toggle() {
    this.unlock();
    if (!this.song) return;
    if (this.mode === "yt") {
      if (this.yt.playing) this.yt.pause();
      else if (this.yt.state === -1 && this.song.video_id) this.yt.load(this.song.video_id);
      else this.yt.play();
      this.#emit();
      return;
    }
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
    if (this.cur.paused) {
      if (!this.cur.src || this.cur.src.startsWith("data:")) return this.resume();
      this.cur.play().catch(() => {});
    } else {
      this.#abortFade();
      this.cur.pause();
    }
    this.#emit();
  }

  // lock screen / headphones: explicit play and pause (a toggle can flip the wrong way)
  play() {
    this.unlock();
    if (!this.song) return;
    if (this.mode === "yt") {
      if (this.yt.state === -1 && this.song.video_id) this.yt.load(this.song.video_id);
      else this.yt.play();
      return this.#emit();
    }
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    if (!this.cur.src || this.cur.src.startsWith("data:")) return this.resume();
    this.cur.play().catch(() => {});
    this.#emit();
  }
  pause() {
    if (this.mode === "yt") {
      this.yt.pause();
      return this.#emit();
    }
    this.#abortFade();
    this.cur.pause();
    this.#emit();
  }

  next() {
    if (!this.queue.length) return;
    this.#abortFade();
    if (this.index < this.queue.length - 1) this.#advance(false);
    else if (this.repeat === "all") {
      this.index = 0;
      this.#loadCurrent(true);
    }
  }

  prev() {
    if (!this.queue.length) return;
    this.#abortFade();
    if (this.time > 3 || this.index === 0) {
      this.cur.currentTime = 0;
      this.#emit();
      return;
    }
    this.index--;
    this.#loadCurrent(true);
  }

  seek(t) {
    if (this.mode === "yt") {
      this.yt.seek(Math.max(0, t));
      this.#emit();
      return;
    }
    this.#abortFade();
    const max = this.partial ? (this.cur.duration || 20) - 0.4 : this.duration - 0.25;
    this.cur.currentTime = Math.max(0, Math.min(t, max));
    this.#emit();
  }

  toggleShuffle() {
    const id = this.queue[this.index];
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      const rest = shuffled(this.queue.filter((x, i) => i !== this.index));
      this.queue = [id, ...rest];
      this.index = 0;
    } else {
      this.queue = this.order.slice();
      this.index = Math.max(0, this.queue.indexOf(id));
    }
    this.#prepareNext(true);
    this.#emit();
  }

  cycleRepeat() {
    this.repeat = { off: "all", all: "one", one: "off" }[this.repeat];
    this.#prepareNext(true);
    this.#emit();
  }

  // Song removed from the library: drop it from the queue
  forget(id) {
    const wasCurrent = this.queue[this.index] === id;
    const before = this.queue.slice(0, this.index).filter((x) => x === id).length;
    this.queue = this.queue.filter((x) => x !== id);
    this.order = this.order.filter((x) => x !== id);
    this.index -= before;
    if (wasCurrent) {
      this.cur.pause();
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      if (this.index >= 0) this.#loadCurrent(false);
      else this.#clear();
    }
    this.#emit();
  }

  /* ---------- internals ---------- */
  #nextIndex() {
    if (this.repeat === "one") return this.index;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    if (this.repeat === "all" && this.queue.length) return 0;
    return -1;
  }

  async #setSrc(el, which, song) {
    if (song.stream) {
      const remote = this.audioResolver ? await this.audioResolver(song, 10) : null;
      if (!remote) throw new Error("not ready");
      if (this.urls[which]) URL.revokeObjectURL(this.urls[which]);
      this.urls[which] = null;
      el.src = remote;
      el.load();
      return;
    }
    const blob = await getAudioBlob(song);
    const url = URL.createObjectURL(blob);
    if (this.urls[which]) URL.revokeObjectURL(this.urls[which]);
    this.urls[which] = url;
    el.src = url;
    el.load();
  }

  async #loadCurrent(autoplay) {
    const song = this.song;
    if (!song) return;
    const token = (this.loadToken = Symbol());
    this.loading = true;
    this.nextId = null;
    this.partial = null;
    if (song.stream) {
      // online song: the PC fetches it (no ads). Instant when it's already fetched; otherwise
      // the first 20 seconds arrive first and the rest takes over without a break.
      for (const el of this.els) el.pause();
      if (!this.audioReady?.(song)) this.#emit("quick");
      let first = null;
      if (this.partResolver) first = await this.partResolver(song, 10).catch(() => null);
      else if (this.audioResolver) {
        const u = await this.audioResolver(song, 10).catch(() => null);
        first = u ? { url: u, full: true } : null;
      }
      if (token !== this.loadToken) return;
      if (!first) {
        this.loading = false;
        this.#emit("nostream");
        return;
      }
      if (!first.full) return this.#playPart(song, first.url, token, autoplay);
    }
    if (this.mode === "yt") {
      this.yt.pause();
      this.mode = "audio";
    }
    this.#emit();
    try {
      this.idle.pause();
      await this.#setSrc(this.cur, this.ci, song);
      if (token !== this.loadToken) return;
      if (this.settings.automix && song.lead_in > 0.3) this.cur.currentTime = song.lead_in;
      if (this.gains) {
        this.gains[this.ci].gain.cancelScheduledValues(this.ctx.currentTime);
        this.gains[this.ci].gain.value = this.#norm(song);
        this.gains[1 - this.ci].gain.value = 0;
      }
      this.loading = false;
      if (autoplay) {
        await this.cur.play().catch(() => {});
        bumpPlay(song);
      }
      this.#updateMeta();
      this.#emit();
      this.#prepareNext();
    } catch (e) {
      if (token !== this.loadToken) return;
      this.loading = false;
      this.#emit("error");
    }
  }

  // Online song: the official YouTube player plays it, nothing is downloaded.
  async #loadStream(song, token) {
    for (const el of this.els) el.pause();
    this.mode = "yt";
    this.yt.init();
    // stay synchronous when we already know the video, so the tap still counts as the gesture
    if (!song.video_id && this.resolver) {
      this.#emit();
      try {
        await this.resolver(song);
      } catch {}
      if (token !== this.loadToken) return;
    }
    if (!song.video_id) {
      this.loading = false;
      this.#emit("nostream");
      return;
    }
    this.yt.load(song.video_id);
    this.loading = false;
    this.startedAt = Date.now();
    this.#updateMeta();
    this.#emit("stream");
    this.#prepareNext();
  }

  // first 20 seconds of an online song
  async #playPart(song, url, token, autoplay) {
    if (this.mode === "yt") {
      this.yt.pause();
      this.mode = "audio";
    }
    this.idle.pause();
    if (this.urls[this.ci]) URL.revokeObjectURL(this.urls[this.ci]);
    this.urls[this.ci] = null;
    this.partial = { id: song.id, waiting: false };
    const el = this.cur;
    el.src = url;
    el.load();
    if (this.gains) {
      this.gains[this.ci].gain.cancelScheduledValues(this.ctx.currentTime);
      this.gains[this.ci].gain.value = this.#norm(song);
      this.gains[1 - this.ci].gain.value = 0;
    }
    this.loading = false;
    if (autoplay) await el.play().catch(() => {});
    this.#updateMeta();
    this.#emit();
    this.audioResolver?.(song, 10).then((full) => full && this.#takeOver(song, full, token)).catch(() => {});
  }

  // the whole song is up: switch from the first-20-seconds file to it at the exact spot
  async #takeOver(song, url, token) {
    const ok = () => token === this.loadToken && this.partial?.id === song.id;
    if (!ok()) return;
    const old = this.cur, ni = 1 - this.ci, nu = this.els[ni];
    if (this.urls[ni]) URL.revokeObjectURL(this.urls[ni]);
    this.urls[ni] = null;
    this.nextId = null;
    nu.src = url;
    nu.load();
    await new Promise((res) => {
      if (nu.readyState >= 1) return res();
      nu.addEventListener("loadedmetadata", res, { once: true });
      setTimeout(res, 20000);
    });
    if (!ok()) return;
    const partEnd = Number.isFinite(old.duration) ? old.duration : 20;
    const running = !old.paused && !old.ended && !this.partial.waiting;
    // aim a moment ahead, wait for the old file to get there, then hand over: no repeat, no gap
    const target = running ? Math.min(old.currentTime + 1.2, partEnd - 0.05) : this.partial.waiting ? partEnd : old.currentTime;
    nu.currentTime = target;
    await new Promise((res) => {
      nu.addEventListener("seeked", res, { once: true });
      setTimeout(res, 2500);
    });
    if (!ok()) return;
    if (running) {
      await new Promise((res) => {
        const iv = setInterval(() => {
          if (!ok() || old.paused || old.ended || old.currentTime >= target - 0.03) {
            clearInterval(iv);
            res();
          }
        }, 15);
      });
      if (!ok()) return;
    }
    const play = running || this.partial.waiting;
    if (this.gains) {
      this.gains[ni].gain.cancelScheduledValues(this.ctx.currentTime);
      this.gains[ni].gain.value = this.#norm(song);
    }
    if (play) await nu.play().catch(() => {});
    old.pause();
    if (this.gains) this.gains[1 - ni].gain.value = 0;
    this.ci = ni;
    this.partial = null;
    this.loading = false;
    this.#emit();
    this.#prepareNext(true);
  }

  // the PC's ad-free copy is ready while YouTube is playing: carry on from the same spot
  async #swapToAudio(song, token) {
    if (token !== this.loadToken || this.mode !== "yt" || this.song?.id !== song.id) return;
    const userPaused = this.yt.state === 2;
    try {
      this.idle.pause();
      await this.#setSrc(this.cur, this.ci, song);
    } catch {
      return;
    }
    if (token !== this.loadToken || this.mode !== "yt") return;
    const t = this.yt.state === 1 || this.yt.state === 2 ? this.yt.time : 0; // 0 while an ad is on
    this.yt.pause();
    this.mode = "audio";
    if (t > 1) {
      const el = this.cur;
      const seek = () => (el.currentTime = t);
      if (el.readyState >= 1) seek();
      else el.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (this.gains) {
      this.gains[this.ci].gain.cancelScheduledValues(this.ctx.currentTime);
      this.gains[this.ci].gain.value = this.#norm(song);
      this.gains[1 - this.ci].gain.value = 0;
    }
    this.loading = false;
    if (!userPaused) await this.cur.play().catch(() => {});
    this.#updateMeta();
    this.#emit("swapped");
    this.#prepareNext(true);
  }

  #onYTState(st) {
    if (this.mode !== "yt") return;
    this.#playState();
    if (st === 0) {
      if (this.repeat === "one") {
        this.yt.seek(0);
        this.yt.play();
        return;
      }
      if (this.#nextIndex() >= 0) this.#advance();
      else this.#emit();
      return;
    }
    this.#emit();
  }

  async #prepareNext(force = false) {
    if (this.partial) return; // the second player is about to take the rest of this song
    const ni = this.#nextIndex();
    const id = ni >= 0 ? this.queue[ni] : null;
    if (!id || id === this.queue[this.index]) {
      this.nextId = null;
      return;
    }
    if (!force && this.nextId === id) return;
    const song = songById(id);
    if (!song) return;
    if (song.stream) {
      this.nextId = null;
      const url = this.audioResolver ? await this.audioResolver(song, 5).catch(() => null) : null;
      if (url && this.queue[this.#nextIndex()] === id && this.queue[this.index] !== id) {
        try {
          await this.#setSrc(this.idle, 1 - this.ci, song);
          this.nextId = id;
          return;
        } catch {}
      }
      this.resolver?.(song).catch(() => {});
      return;
    }
    this.nextId = null;
    try {
      await this.#setSrc(this.idle, 1 - this.ci, song);
      const lead = this.settings.automix && song.lead_in > 0.3 ? song.lead_in : 0;
      if (lead) {
        const el = this.idle;
        const seek = () => (el.currentTime = lead);
        if (el.readyState >= 1) seek();
        else el.addEventListener("loadedmetadata", seek, { once: true });
      }
      this.nextId = id;
    } catch {
      this.nextId = null;
    }
  }

  #onEnded() {
    if (this.fading) return;
    if (this.partial && this.partial.id === this.song?.id) {
      // the first 20 seconds ran out before the rest arrived: hold here, it continues when it lands
      this.partial.waiting = true;
      this.loading = true;
      this.#emit("quick");
      return;
    }
    if (this.repeat === "one") {
      this.cur.currentTime = this.settings.automix ? this.song?.lead_in || 0 : 0;
      this.cur.play().catch(() => {});
      return;
    }
    if (this.#nextIndex() < 0) {
      this.#emit();
      return;
    }
    this.#advance(true);
  }

  #advance() {
    const ni = this.#nextIndex();
    if (ni < 0) return;
    this.partial = null;
    const ready = this.nextId === this.queue[ni];
    const old = this.cur;
    this.index = ni;
    if (ready && this.mode === "yt") {
      this.yt.pause();
      this.mode = "audio";
    }
    if (ready) {
      this.ci = 1 - this.ci;
      if (this.gains) {
        this.gains[this.ci].gain.value = this.#norm(this.song);
        this.gains[1 - this.ci].gain.value = 0;
      }
      old.pause();
      this.cur.play().catch(() => {});
      bumpPlay(this.song);
      this.nextId = null;
      this.#updateMeta();
      this.#emit();
      this.#prepareNext();
    } else {
      this.#loadCurrent(true);
    }
  }

  #onTime() {
    if (this.mode !== "audio") return;
    this.#positionState();
    this.#emit("time");
    if (!this.gains && this.settings.automix && this.nextId && !this.fading && this.repeat !== "one" && !this.cur.paused) {
      const out = this.song?.outro;
      if (out && out > 20 && this.time >= out && this.time < this.duration - 0.3) return this.#advance();
    }
    const mp = this.mixPoint;
    if (
      mp === null ||
      this.fading ||
      !this.gains ||
      document.hidden ||
      this.repeat === "one" ||
      this.cur.paused ||
      !this.nextId
    )
      return;
    if (this.time >= mp && this.time < this.duration - 0.4) this.#startFade();
  }

  #startFade() {
    const ni = this.#nextIndex();
    if (ni < 0 || this.nextId !== this.queue[ni]) return;
    this.fading = true;
    const dur = Math.max(1, Math.min(this.settings.fade, this.duration - this.time));
    const now = this.ctx.currentTime;
    const out = this.gains[this.ci].gain;
    const inn = this.gains[1 - this.ci].gain;
    const nextSong = songById(this.nextId);
    const a = out.value || this.#norm(this.song);
    const b = this.#norm(nextSong);
    // equal-power curves so the blend doesn't dip in the middle
    const N = 48;
    const outCurve = new Float32Array(N);
    const inCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      outCurve[i] = a * Math.cos((x * Math.PI) / 2);
      inCurve[i] = b * Math.sin((x * Math.PI) / 2);
    }
    out.cancelScheduledValues(now);
    inn.cancelScheduledValues(now);
    inn.value = 0;
    this.idle.play().catch(() => {});
    out.setValueCurveAtTime(outCurve, now, dur);
    inn.setValueCurveAtTime(inCurve, now, dur);
    this.fadeInfo = { from: this.song?.id, to: this.nextId, start: performance.now(), dur };
    this.#emit("fade");
    this.fadeTimer = setTimeout(() => this.#finishFade(), dur * 1000 + 60);
  }

  #finishFade() {
    if (!this.fading) return;
    clearTimeout(this.fadeTimer);
    const old = this.cur;
    this.fading = false;
    this.fadeInfo = null;
    this.index = this.#nextIndex();
    this.ci = 1 - this.ci;
    old.pause();
    if (this.gains) {
      const now = this.ctx.currentTime;
      this.gains[1 - this.ci].gain.cancelScheduledValues(now);
      this.gains[1 - this.ci].gain.value = 0;
      this.gains[this.ci].gain.cancelScheduledValues(now);
      this.gains[this.ci].gain.value = this.#norm(this.song);
    }
    bumpPlay(this.song);
    this.nextId = null;
    this.#updateMeta();
    this.#emit();
    this.#prepareNext();
  }

  // User acted mid-fade: snap to the incoming song.
  #abortFade() {
    if (this.fading) this.#finishFade();
  }

  #clear() {
    this.cur.removeAttribute("src");
    this.cur.load();
    this.queue = [];
    this.index = -1;
    this.#emit();
  }

  // Quiet loud masters down toward -11 LUFS; never boost (avoids clipping).
  #norm(song) {
    if (!song || song.lufs == null) return 0.85;
    const g = Math.pow(10, (-11 - song.lufs) / 20);
    return Math.max(0.3, Math.min(1, g));
  }

  /* ---------- lock screen ---------- */
  #bindMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (a, fn) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {}
    };
    set("play", () => this.play());
    set("pause", () => this.pause());
    set("stop", () => this.pause());
    set("nexttrack", () => this.next());
    set("previoustrack", () => this.prev());
    set("seekto", (d) => d.seekTime != null && this.seek(d.seekTime));
  }

  async #updateMeta() {
    const ms = navigator.mediaSession;
    const s = this.song;
    if (!ms || !s) return;
    const art = coverURLSync(s.id) || (await getCoverURL(s));
    try {
      ms.metadata = new MediaMetadata({
        title: s.title,
        artist: s.artist || "",
        album: "Tarab",
        artwork: art ? [{ src: art, sizes: "600x600", type: "image/jpeg" }] : [],
      });
    } catch {}
    this.#saveSession();
  }

  #playState() {
    try {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
    } catch {}
  }

  #lastPos = 0;
  #positionState() {
    const now = performance.now();
    if (now - this.#lastPos < 1000) return;
    this.#lastPos = now;
    try {
      if (this.duration)
        navigator.mediaSession?.setPositionState?.({
          duration: this.duration,
          playbackRate: 1,
          position: Math.min(this.time, this.duration),
        });
    } catch {}
  }

  #saveSession() {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ queue: this.queue, order: this.order, index: this.index, time: this.time, shuffle: this.shuffle, repeat: this.repeat })
      );
    } catch {}
  }

  restoreSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!s || !s.queue?.length) return;
      this.queue = s.queue.filter((id) => songById(id));
      this.order = (s.order || s.queue).filter((id) => songById(id));
      this.index = Math.min(Math.max(0, s.index), this.queue.length - 1);
      this.shuffle = !!s.shuffle;
      this.repeat = s.repeat || "off";
      this.resumeAt = s.time || 0;
      this.#emit();
    } catch {}
  }

  // first play after reopening the app: load and jump to the saved spot
  async resume() {
    this.unlock();
    const t = this.resumeAt || 0;
    this.resumeAt = 0;
    await this.#loadCurrent(false);
    if (t > 1 && t < this.duration - 2) this.cur.currentTime = t;
    await this.cur.play().catch(() => {});
    this.#emit();
  }

  #emit(type = "state") {
    this.dispatchEvent(new CustomEvent("change", { detail: type }));
  }
}

function shuffled(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export const player = new Player();
