"""
Tarab PC worker.
Watches your Tarab queue in Supabase, downloads each link with yt-dlp,
uploads the audio + cover to your Tarab storage, and adds it to your library.
Runs hidden in the background; starts with Windows.
Log: tarab.log next to this file.
"""
import json
import logging
import logging.handlers
import os
import platform
import re
import shutil
import socket
import struct
import threading
from datetime import datetime
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

VERSION = "1.5.0"
SCRIPT_URL = "https://tarab-music-76z3.netlify.app/pc/tarab_worker.py"
DEFAULT_URL = "https://faafhcbjprtsvyximbtm.supabase.co"
DEFAULT_KEY = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYWZoY2JqcHJ0c3Z5eGltYnRtIiwicm9s"
               "ZSI6ImFub24iLCJpYXQiOjE3OTM1NDQ1ODAsImV4cCI6MjEwOTEyMDU4MH0.pSPeeY5Iai6DIeGQjcpHhThS7DNNUB-6GoiUpjoTyBg")
APP_ICON = "https://tarab-music-76z3.netlify.app/icons/icon-512.png"
HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
STATE = HERE / "state.json"
LOG = HERE / "tarab.log"
LOCK_PORT = 47831
IDLE_POLL = 4
HEARTBEAT_EVERY = 30
UPDATE_EVERY = 24 * 3600
IMPORT_DIR = Path.home() / "Music" / "Tarab"
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".webm", ".wma", ".aiff", ".aif", ".alac"}

log = logging.getLogger("tarab")
log.setLevel(logging.INFO)
_h = logging.handlers.RotatingFileHandler(LOG, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
_h.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(message)s"))
log.addHandler(_h)
if sys.stdout and sys.stdout.isatty():
    log.addHandler(logging.StreamHandler(sys.stdout))


def extend_path():
    """winget installs ffmpeg/deno in places the current process may not see yet."""
    extra = []
    la = os.environ.get("LOCALAPPDATA")
    up = os.environ.get("USERPROFILE")
    if la:
        extra.append(os.path.join(la, "Microsoft", "WinGet", "Links"))
        pk = Path(la) / "Microsoft" / "WinGet" / "Packages"
        if pk.exists():
            for p in pk.glob("Gyan.FFmpeg*/*/bin"):
                extra.append(str(p))
            for p in pk.glob("DenoLand.Deno*"):
                extra.append(str(p))
    if up:
        extra.append(os.path.join(up, ".deno", "bin"))
    for p in extra:
        if os.path.isdir(p) and p not in os.environ.get("PATH", ""):
            os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(p, data):
    Path(p).write_text(json.dumps(data, indent=2), encoding="utf-8")


def self_update():
    st = load_json(STATE, {})
    if time.time() - st.get("last_update", 0) < UPDATE_EVERY:
        return False
    log.info("Updating yt-dlp ...")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-U", "--quiet", "yt-dlp[default]"],
            check=True, timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        log.info("yt-dlp up to date")
    except Exception as e:
        log.warning("yt-dlp update failed: %s", e)
    st["last_update"] = time.time()
    save_json(STATE, st)
    return True


import requests  # noqa: E402


def update_script():
    """Pull a newer tarab_worker.py from the Tarab site. Returns True if replaced."""
    try:
        r = requests.get(SCRIPT_URL, timeout=20)
        if r.status_code != 200 or 'VERSION = "' not in r.text:
            return False
        m = re.search(r'VERSION = "([\d.]+)"', r.text)
        if not m or tuple(map(int, m[1].split("."))) <= tuple(map(int, VERSION.split("."))):
            return False
        compile(r.text, "tarab_worker.py", "exec")  # never install a broken file
        me = Path(__file__).resolve()
        tmp = me.with_suffix(".new")
        tmp.write_text(r.text, encoding="utf-8")
        os.replace(tmp, me)
        log.info("Script updated to %s", m[1])
        return True
    except Exception as e:
        log.warning("script update: %s", e)
        return False


class Supa:
    def __init__(self, cfg):
        self.url = cfg["url"].rstrip("/")
        self.key = cfg["key"]
        self.email = cfg["email"]
        self.password = cfg["password"]
        self.token = None
        self.refresh = None
        self.expires = 0
        self.uid = None
        self.s = requests.Session()

    def login(self):
        if self.password is None and os.environ.get("TARAB_CLOUD_KEY"):
            # cloud runner: a private key (GitHub secret) is swapped for a session, no password needed
            r = self.s.post(f"{self.url}/functions/v1/cloudauth", json={"key": os.environ["TARAB_CLOUD_KEY"]}, timeout=30)
            if r.status_code != 200:
                raise RuntimeError(f"Cloud key refused: {r.text[:200]}")
            self._take(r.json())
            return
        r = self.s.post(
            f"{self.url}/auth/v1/token?grant_type=password",
            headers={"apikey": self.key},
            json={"email": self.email, "password": self.password},
            timeout=30,
        )
        if r.status_code != 200:
            raise RuntimeError(f"Login failed: {r.text[:200]}")
        self._take(r.json())

    def _take(self, d):
        self.token = d["access_token"]
        self.refresh = d.get("refresh_token")
        self.expires = time.time() + int(d.get("expires_in", 3600)) - 120
        self.uid = d["user"]["id"]

    def ensure(self):
        if self.token and time.time() < self.expires:
            return
        if self.refresh:
            r = self.s.post(
                f"{self.url}/auth/v1/token?grant_type=refresh_token",
                headers={"apikey": self.key},
                json={"refresh_token": self.refresh},
                timeout=30,
            )
            if r.status_code == 200:
                self._take(r.json())
                return
        self.login()

    def h(self, extra=None):
        self.ensure()
        h = {"apikey": self.key, "Authorization": f"Bearer {self.token}"}
        if extra:
            h.update(extra)
        return h

    def rest(self, method, path, **kw):
        headers = self.h(kw.pop("headers", None))
        r = self.s.request(method, f"{self.url}/rest/v1/{path}", headers=headers, timeout=30, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text[:200]}")
        return r.json() if r.text else None

    def upload(self, path, file, ctype):
        with open(file, "rb") as f:
            r = self.s.post(
                f"{self.url}/storage/v1/object/music/{path}",
                headers=self.h({"Content-Type": ctype, "x-upsert": "true", "cache-control": "31536000"}),
                data=f,
                timeout=600,
            )
        if r.status_code >= 400:
            raise RuntimeError(f"upload: {r.status_code} {r.text[:200]}")


# ---------------- helpers ----------------

JUNK = re.compile(
    r"\s*[\(\[](official|lyrics?|audio|video|clip|music video|visuali[sz]er|hd|hq|4k|paroles|"
    r"exclusive|videoclip|audio officiel|clip officiel|official audio|official video)[^\)\]]*[\)\]]",
    re.I,
)


def clean(s):
    s = JUNK.sub("", s or "")
    s = re.sub(r"\s*\|.*$", "", s)
    return re.sub(r"\s{2,}", " ", s).strip(" -–—")


def title_artist(info):
    track = info.get("track")
    artist = info.get("artist") or (", ".join(info["artists"]) if info.get("artists") else None) or info.get("creator")
    if track and artist:
        return clean(track) or track, artist
    raw = info.get("title") or "Bla smiya"
    for sep in (" - ", " – ", " — ", " | "):
        if sep in raw:
            a, t = raw.split(sep, 1)
            if clean(t) and len(a) < 60:
                return clean(t), a.strip()
    up = info.get("uploader") or info.get("channel") or ""
    up = re.sub(r"\s*-\s*Topic$|VEVO$", "", up).strip()
    return clean(raw) or raw, up or None


def analyze(file):
    """Leading silence, where the ending fades out, loudness (for AutoMix), duration."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return 0.0, None, None, None
    try:
        p = subprocess.run(
            [ff, "-hide_banner", "-nostats", "-i", str(file), "-af", "silencedetect=noise=-42dB:d=0.4,ebur128", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        out = p.stderr
        starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", out)]
        ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
        dur_m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
        dur = int(dur_m[1]) * 3600 + int(dur_m[2]) * 60 + float(dur_m[3]) if dur_m else None
        lead = 0.0
        if starts and starts[0] <= 0.2 and ends:
            lead = min(ends[0], 15.0)
        outro = None
        if starts and dur:
            last = starts[-1]
            # trailing silence = a silence that starts and never ends (or ends at the very end)
            if len(ends) < len(starts) or (ends and ends[-1] >= dur - 0.3):
                if last > dur * 0.5:
                    outro = last
        lufs_m = re.findall(r"I:\s+(-?[\d.]+) LUFS", out)
        lufs = float(lufs_m[-1]) if lufs_m else None
        return lead, outro, lufs, dur
    except Exception as e:
        log.warning("analyze failed: %s", e)
        return 0.0, None, None, None


def square_cover(src, dst):
    from PIL import Image

    im = Image.open(src).convert("RGB")
    w, h = im.size
    side = min(w, h)
    # YouTube thumbnails are 16:9 with the art in the middle
    im = im.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    im = im.resize((600, 600), Image.LANCZOS)
    im.save(dst, "JPEG", quality=86, optimize=True)


BAD_WORDS = ("live", "cover", "remix", "karaoke", "slowed", "sped up", "8d", "instrumental", "reaction",
             "nightcore", "bass boost", "reverb", "acapella", "tutorial", "lesson", "full album")


def _words(x):
    return [w for w in re.sub(r"[^\w\s]", " ", (x or "").lower()).split() if len(w) > 1]


def rank_candidates(entries, meta):
    """Best-first list of results that plausibly are the studio version of the track."""
    want = f"{meta.get('title', '')} {meta.get('version', '')}".lower()
    target = meta.get("duration")
    artist = (meta.get("artist") or "").lower()
    title_words = _words(meta.get("title"))
    out = []
    for i, e in enumerate(entries):
        t = (e.get("title") or "").lower()
        ch = (e.get("channel") or e.get("uploader") or "").lower()
        d = e.get("duration")
        topic = ch.endswith(" - topic")
        have = set(_words(t) + _words(ch))
        overlap = sum(w in have for w in title_words) / len(title_words) if title_words else 1
        diff = abs(d - target) if (target and d) else None
        # clearly another song: nothing in common and a very different length
        if not topic and overlap == 0 and (diff is None or diff > 10):
            continue
        if diff is not None and diff > max(45, target * 0.3):
            continue
        if d and d > 1200:
            continue
        score = -i * 3 + overlap * 20
        if diff is not None:
            score -= min(diff, 180) / 2
            if diff <= 3:
                score += 12
        for w in BAD_WORDS:
            if w in t and w not in want:
                score -= 25
        if topic:
            score += 14
        if "official audio" in t or "audio officiel" in t:
            score += 6
        if artist and (artist in ch or ch.replace(" - topic", "") in artist):
            score += 8
        out.append((score, e))
    out.sort(key=lambda x: -x[0])
    return [e for _, e in out]


def pick_best(entries, meta):
    r = rank_candidates(entries, meta)
    return r[0] if r else None


def entry_url(e):
    u = e.get("url") or e.get("webpage_url") or ""
    if u.startswith("http"):
        return u
    if e.get("id") and len(e["id"]) == 11:
        return f"https://www.youtube.com/watch?v={e['id']}"
    return None


def public_cover(meta, info):
    """A short public image URL (Discord shows it next to your status)."""
    if meta.get("cover") and len(meta["cover"]) < 250:
        return meta["cover"]
    if (info.get("extractor_key") or "").lower().startswith("youtube") and info.get("id"):
        return f"https://i.ytimg.com/vi/{info['id']}/hqdefault.jpg"
    th = info.get("thumbnail")
    return th if th and len(th) < 250 else None


class NotFound(Exception):
    pass


def friendly(err):
    if isinstance(err, NotFound):
        return "Not found on YouTube or SoundCloud. Paste a link or upload the file."
    e = str(err)
    if "confirm you" in e and "bot" in e:
        return "YouTube is blocking downloads for now. Try again in a bit."
    if "Private video" in e:
        return "Private video"
    if "not available in your country" in e.lower() or "blocked it in your country" in e.lower():
        return "This video is blocked in your country"
    if "unavailable" in e.lower():
        return "Video unavailable"
    if "Unsupported URL" in e:
        return "Unsupported link"
    if "age" in e.lower() and "confirm" in e.lower():
        return "Age-restricted video"
    if "ffmpeg" in e.lower():
        return "ffmpeg is missing on the PC"
    line = e.strip().splitlines()[-1] if e.strip() else "Erreur"
    return re.sub(r"^ERROR:\s*", "", line)[:160]


# ---------------- worker ----------------

class Worker:
    def __init__(self, sb, cloud=False):
        self.sb = sb
        self.cloud = cloud
        self.last_beat = 0
        self.last_progress = 0

    def beat(self, force=False):
        if self.cloud:
            return  # the app shows "PC m3all9" from heartbeats; the cloud runner must not send them
        if not force and time.time() - self.last_beat < HEARTBEAT_EVERY:
            return
        try:
            self.sb.rest(
                "POST", "worker_status?on_conflict=user_id",
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                json={"user_id": self.sb.uid, "last_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                      "machine": platform.node()[:60], "version": VERSION},
            )
            self.last_beat = time.time()
        except Exception as e:
            log.warning("heartbeat: %s", e)

    def job_update(self, jid, **fields):
        self.sb.rest("PATCH", f"jobs?id=eq.{jid}", headers={"Prefer": "return=minimal"}, json=fields)

    def claim(self):
        rows = self.sb.rest("GET", "jobs?status=eq.pending&order=created_at.asc&limit=1&select=*")
        if not rows:
            return None
        j = rows[0]
        got = self.sb.rest(
            "PATCH", f"jobs?id=eq.{j['id']}&status=eq.pending",
            headers={"Prefer": "return=representation"}, json={"status": "working", "progress": 0, "worker": "cloud" if self.cloud else "pc"},
        )
        return got[0] if got else None

    def run(self):
        log.info("Tarab worker %s started as %s", VERSION, self.sb.email)
        # jobs stuck from a crash/shutdown go back in line
        try:
            self.sb.rest("PATCH", "jobs?status=eq.working", headers={"Prefer": "return=minimal"},
                         json={"status": "pending", "progress": 0})
        except Exception as e:
            log.warning("reset: %s", e)
        started = time.time()
        while True:
            try:
                self.beat()
                job = self.claim()
                if job:
                    self.process(job)
                    continue
                self.scan_import()
            except requests.RequestException as e:
                log.warning("network: %s", e)
                time.sleep(15)
            except Exception as e:
                log.exception("loop: %s", e)
                time.sleep(10)
            if time.time() - started > UPDATE_EVERY:
                restart()
            time.sleep(IDLE_POLL)

    def run_cloud(self):
        """GitHub Actions: download whatever is waiting, then stop."""
        log.info("Tarab cloud %s started", VERSION)
        try:  # lets the app show "Cloud active" even without a GitHub token
            self.sb.rest("POST", "user_settings?on_conflict=user_id",
                         headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                         json={"user_id": self.sb.uid, "cloud_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        except Exception as e:
            log.warning("cloud_seen: %s", e)
        started, idle_since = time.time(), time.time()
        while time.time() - started < 33 * 60:
            try:
                job = self.claim()
            except Exception as e:
                log.warning("claim: %s", e)
                job = None
            if job:
                self.process(job)
                idle_since = time.time()
                continue
            if time.time() - idle_since > 90:
                break
            time.sleep(5)
        log.info("Cloud run finished")

    def process(self, job):
        jid, url = job["id"], job["url"]
        log.info("Job %s: %s", jid, url)
        import yt_dlp

        try:
            if url.startswith(("ytsearch", "scsearch")):
                self.search_and_download(job)
                return
            if re.search(r"(youtu\.be/|[?&]v=|/shorts/)", url):
                # plain video link: skip the extra lookup
                self.download_one(job, url)
                return
            probe_opts = {"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "noplaylist": True, "skip_download": True}
            with yt_dlp.YoutubeDL(probe_opts) as y:
                info = y.extract_info(url, download=False)
            if info.get("_type") in ("playlist", "multi_video") and info.get("entries"):
                self.expand_playlist(job, info)
                return
            self.download_one(job, url)
        except Exception as e:
            log.warning("Job %s failed: %s", jid, e)
            try:
                self.job_update(jid, status="error", error=friendly(e))
            except Exception:
                pass

    def search_and_download(self, job):
        """Try several searches (YouTube, then SoundCloud) and several results before giving up."""
        import yt_dlp

        meta = job.get("meta") or {}
        a, t = meta.get("artist") or "", meta.get("title") or ""
        queries = [job["url"], f"ytsearch10:{a} {t}", f"ytsearch8:{t} {a} audio", f"scsearch6:{a} {t}"]
        tried, attempts, last_err = set(), 0, None
        # YouTube Music's own match (same one the app streams) goes first
        if meta.get("deezer_id"):
            try:
                r = self.sb.s.post(f"{self.sb.url}/functions/v1/yt", headers=self.sb.h({"Content-Type": "application/json"}),
                                   json={"items": [{"id": meta["deezer_id"], "title": t, "artist": a, "duration": meta.get("duration")}]},
                                   timeout=40)
                vid = (r.json().get("results") or {}).get(str(meta["deezer_id"]))
                if vid:
                    u = f"https://www.youtube.com/watch?v={vid}"
                    tried.add(u)
                    attempts += 1
                    log.info("YT Music match for %s -> %s", t, vid)
                    try:
                        self.download_one(job, u)
                        return
                    except Exception as err:
                        last_err = err
                        log.warning("yt music match failed: %s", err)
            except Exception as e:
                log.warning("yt lookup: %s", e)
        flat = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True}
        for q in queries:
            try:
                with yt_dlp.YoutubeDL(flat) as y:
                    res = y.extract_info(q, download=False)
            except Exception as e:
                last_err = e
                log.warning("search %s: %s", q, e)
                continue
            for e in rank_candidates([x for x in (res.get("entries") or []) if x], meta):
                u = entry_url(e)
                if not u or u in tried:
                    continue
                tried.add(u)
                attempts += 1
                log.info("Try %s -> %s (%s)", t, e.get("title"), u)
                try:
                    self.download_one(job, u)
                    return
                except Exception as err:
                    last_err = err
                    log.warning("candidate failed: %s", err)
                if attempts >= 5:
                    break
            if attempts >= 5:
                break
        if attempts == 0:
            raise NotFound()
        raise last_err or NotFound()

    # ---------- files dropped into Music\Tarab on the PC ----------
    last_scan = 0

    def scan_import(self):
        if time.time() - self.last_scan < 20:
            return
        self.last_scan = time.time()
        try:
            (IMPORT_DIR / "Tzado").mkdir(parents=True, exist_ok=True)
        except Exception:
            return
        for f in sorted(IMPORT_DIR.iterdir()):
            if not f.is_file() or f.suffix.lower() not in AUDIO_EXT:
                continue
            if time.time() - f.stat().st_mtime < 8:  # still being copied
                continue
            try:
                self.import_file(f)
                dest = IMPORT_DIR / "Tzado" / f.name
                if dest.exists():
                    dest = dest.with_name(f"{f.stem}-{int(time.time())}{f.suffix}")
                shutil.move(str(f), str(dest))
            except Exception as e:
                log.warning("import %s: %s", f.name, e)
                bad = IMPORT_DIR / "Ma tzadouch"
                bad.mkdir(exist_ok=True)
                try:
                    shutil.move(str(f), str(bad / f.name))
                except Exception:
                    pass

    def import_file(self, f):
        log.info("Import %s", f.name)
        ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
        no_win = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        tags, dur = {}, None
        if fp:
            p = subprocess.run([fp, "-v", "quiet", "-print_format", "json", "-show_format", str(f)],
                               capture_output=True, text=True, timeout=60, creationflags=no_win)
            fmt = (json.loads(p.stdout or "{}").get("format") or {})
            tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
            dur = float(fmt["duration"]) if fmt.get("duration") else None
        title, artist = tags.get("title"), tags.get("artist") or tags.get("album_artist")
        if not title:
            stem = re.sub(r"[_]+", " ", f.stem).strip()
            if " - " in stem:
                artist_guess, title = stem.split(" - ", 1)
                artist = artist or artist_guess.strip()
            else:
                title = stem
        tmp = Path(tempfile.mkdtemp(prefix="tarab_imp_"))
        try:
            ext = f.suffix.lower()
            audio = f
            if ext not in (".m4a", ".mp3", ".aac"):
                if not ff:
                    raise RuntimeError("ffmpeg missing for " + ext)
                audio = tmp / "audio.m4a"
                subprocess.run([ff, "-y", "-v", "error", "-i", str(f), "-vn", "-c:a", "aac", "-b:a", "256k", str(audio)],
                               check=True, timeout=900, creationflags=no_win)
            out_ext = audio.suffix.lower().lstrip(".")
            ctype = {"m4a": "audio/mp4", "mp3": "audio/mpeg", "aac": "audio/aac"}[out_ext]
            lead, outro, lufs, fdur = analyze(audio)
            song_id = str(uuid.uuid4())
            base = f"{self.sb.uid}/{song_id}"
            self.sb.upload(f"{base}.{out_ext}", audio, ctype)
            cover_path = None
            if ff:
                art = tmp / "art.jpg"
                subprocess.run([ff, "-y", "-v", "error", "-i", str(f), "-an", "-frames:v", "1", str(art)],
                               timeout=60, creationflags=no_win, capture_output=True)
                if art.exists() and art.stat().st_size > 1000:
                    try:
                        sq = tmp / "cover.jpg"
                        square_cover(art, sq)
                        self.sb.upload(f"{base}.jpg", sq, "image/jpeg")
                        cover_path = f"{base}.jpg"
                    except Exception as e:
                        log.warning("import cover: %s", e)
            self.sb.rest("POST", "songs", headers={"Prefer": "return=minimal"}, json={
                "id": song_id, "title": (title or f.stem)[:200], "artist": (artist or "")[:120] or None,
                "album": (tags.get("album") or "")[:200] or None,
                "duration": round(dur or fdur or 0, 2) or None, "source_url": None,
                "audio_path": f"{base}.{out_ext}", "cover_path": cover_path, "ext": out_ext,
                "size_bytes": audio.stat().st_size, "lead_in": round(lead, 2),
                "outro": round(outro, 2) if outro else None, "lufs": round(lufs, 1) if lufs is not None else None,
            })
            log.info("Imported %s", title)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def expand_playlist(self, job, info):
        entries = [e for e in info["entries"] if e][:200]
        pl_id = job.get("playlist_id")
        name = info.get("title") or "Playlist"
        if not pl_id:
            row = self.sb.rest("POST", "playlists", headers={"Prefer": "return=representation"}, json={"name": name[:80]})
            pl_id = row[0]["id"]
        rows = []
        for e in entries:
            u = e.get("url") or e.get("webpage_url") or ""
            if not u.startswith("http"):
                if e.get("ie_key", "").lower().startswith("youtube") or len(e.get("id", "")) == 11:
                    u = f"https://www.youtube.com/watch?v={e['id']}"
                else:
                    continue
            rows.append({"url": u, "playlist_id": pl_id, "title": e.get("title")})
        if rows:
            self.sb.rest("POST", "jobs", headers={"Prefer": "return=minimal"}, json=rows)
        self.job_update(job["id"], status="done", progress=100, title=f"Playlist: {name} ({len(rows)})")
        log.info("Playlist %s -> %d jobs", name, len(rows))

    def download_one(self, job, url):
        import yt_dlp

        jid = job["id"]
        has_ff = bool(shutil.which("ffmpeg"))
        tmp = Path(tempfile.mkdtemp(prefix="tarab_"))
        self.last_progress = 0

        def hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                if total:
                    pct = int(d.get("downloaded_bytes", 0) * 100 / total)
                    if pct - self.last_progress >= 8:
                        self.last_progress = pct
                        try:
                            self.job_update(jid, progress=min(pct, 99))
                        except Exception:
                            pass
                self.beat()

        opts = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "outtmpl": str(tmp / "%(id)s.%(ext)s"),
            "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
            "progress_hooks": [hook],
            "writethumbnail": True,
            "retries": 5,
            "fragment_retries": 5,
            "concurrent_fragment_downloads": 4,
        }
        if has_ff:
            opts["postprocessors"] = [
                {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "256"},
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg"},
            ]
        try:
            with yt_dlp.YoutubeDL(opts) as y:
                info = y.extract_info(url, download=True)
            meta = job.get("meta") or {}
            title, artist = title_artist(info)
            if meta.get("title"):
                title, artist = meta["title"], meta.get("artist") or artist
            self.job_update(jid, progress=100, title=title)

            audio = next((p for p in tmp.iterdir() if p.suffix.lower() in (".m4a", ".mp4", ".aac")), None)
            if not audio:
                audio = next((p for p in tmp.iterdir() if p.suffix.lower() in (".mp3", ".webm", ".opus", ".ogg")), None)
            if not audio:
                raise RuntimeError("No audio file found")
            ext = audio.suffix.lower().lstrip(".")
            ctype = {"m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac", "mp3": "audio/mpeg",
                     "webm": "audio/webm", "opus": "audio/ogg", "ogg": "audio/ogg"}.get(ext, "application/octet-stream")

            lead, outro, lufs, fdur = analyze(audio)
            song_id = str(uuid.uuid4())
            base = f"{self.sb.uid}/{song_id}"
            self.sb.upload(f"{base}.{ext}", audio, ctype)

            cover_path = None
            thumb = None
            if meta.get("cover"):
                try:
                    r = requests.get(meta["cover"], timeout=30)
                    if r.ok and len(r.content) > 1000:
                        thumb = tmp / "catalog_cover.jpg"
                        thumb.write_bytes(r.content)
                except Exception as e:
                    log.warning("catalog cover: %s", e)
            if not thumb:
                thumb = next((p for p in tmp.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")), None)
            if thumb:
                try:
                    sq = tmp / "cover_sq.jpg"
                    square_cover(thumb, sq)
                    self.sb.upload(f"{base}.jpg", sq, "image/jpeg")
                    cover_path = f"{base}.jpg"
                except Exception as e:
                    log.warning("cover: %s", e)

            song = {
                "id": song_id,
                "title": title[:200],
                "artist": (artist or "")[:120] or None,
                "duration": info.get("duration") or (round(fdur, 2) if fdur else None),
                "source_url": info.get("webpage_url") or url,
                "audio_path": f"{base}.{ext}",
                "cover_path": cover_path,
                "ext": ext,
                "size_bytes": audio.stat().st_size,
                "lead_in": round(lead, 2),
                "outro": round(outro, 2) if outro else None,
                "lufs": round(lufs, 1) if lufs is not None else None,
                "album": (meta.get("album") or "")[:200] or None,
                "deezer_id": meta.get("deezer_id"),
                "cover_url": public_cover(meta, info),
            }
            self.sb.rest("POST", "songs", headers={"Prefer": "return=minimal"}, json=song)
            if job.get("playlist_id"):
                try:
                    self.sb.rest("POST", "playlist_songs", headers={"Prefer": "return=minimal"},
                                 json={"playlist_id": job["playlist_id"], "song_id": song_id, "position": time.time()})
                except Exception as e:
                    log.warning("playlist add: %s", e)
            self.job_update(jid, status="done", progress=100, song_id=song_id, title=title, error=None)
            log.info("Done: %s - %s", artist, title)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class DiscordIPC:
    """Minimal Discord Rich Presence client (local IPC to the Discord desktop app)."""

    def __init__(self, client_id):
        self.cid = str(client_id)
        self.f = None
        self.sock = None

    def connect(self):
        if os.name == "nt":
            for i in range(10):
                try:
                    self.f = open(rf"\\?\pipe\discord-ipc-{i}", "r+b", buffering=0)
                    break
                except OSError:
                    continue
        else:
            base = os.environ.get("XDG_RUNTIME_DIR") or os.environ.get("TMPDIR") or "/tmp"
            for d in (base, os.path.join(base, "app/com.discordapp.Discord"), os.path.join(base, "snap.discord")):
                for i in range(10):
                    path = os.path.join(d, f"discord-ipc-{i}")
                    if os.path.exists(path):
                        try:
                            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                            s.connect(path)
                            self.sock = s
                            break
                        except OSError:
                            continue
                if self.sock:
                    break
        if not self.f and not self.sock:
            raise ConnectionError("Discord machi m7loul")
        self._send(0, {"v": 1, "client_id": self.cid})
        op, data = self._recv()
        if data.get("evt") != "READY":
            raise ConnectionError(f"Discord: {data.get('data', {}).get('message', data)}")

    def _write(self, b):
        if self.f:
            self.f.write(b)
            self.f.flush()
        else:
            self.sock.sendall(b)

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.f.read(n - len(buf)) if self.f else self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Discord t9at3")
            buf += chunk
        return buf

    def _send(self, op, payload):
        data = json.dumps(payload).encode("utf-8")
        self._write(struct.pack("<II", op, len(data)) + data)

    def _recv(self):
        op, ln = struct.unpack("<II", self._read(8))
        return op, json.loads(self._read(ln).decode("utf-8"))

    def set_activity(self, activity):
        self._send(1, {"cmd": "SET_ACTIVITY", "args": {"pid": os.getpid(), "activity": activity}, "nonce": str(uuid.uuid4())})
        while True:
            op, data = self._recv()
            if data.get("cmd") == "SET_ACTIVITY":
                if data.get("evt") == "ERROR":
                    raise ValueError(data.get("data", {}).get("message", "activity error"))
                return data

    def close(self):
        try:
            if self.f:
                self.f.close()
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.f = self.sock = None


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def build_activity(np, now=None):
    """Turn the now_playing row into a Discord 'Listening to' activity, or None to clear."""
    now = now or time.time()
    if not np or not np.get("playing") or not np.get("title"):
        return None
    dur = float(np.get("duration") or 0)
    pos = float(np.get("position") or 0)
    start = _ts(np["updated_at"]) - pos
    if dur and now > start + dur + 20:  # song over and no update since: the phone stopped
        return None
    if now - _ts(np["updated_at"]) > 3 * 3600:
        return None

    def pad(x):
        return (x or "").strip().ljust(2)[:128]

    act = {
        "type": 2,
        "details": pad(np["title"]),
        "state": pad(np.get("artist") or "Tarab"),
        "assets": {
            "large_image": np.get("cover_url") or APP_ICON,
            "large_text": pad(np.get("album") or np["title"]),
            "small_image": APP_ICON,
            "small_text": "Tarab",
        },
        "status_display_type": 2,
    }
    if dur:
        act["timestamps"] = {"start": int(start * 1000), "end": int((start + dur) * 1000)}
    src = np.get("source_url") or ""
    if src.startswith("http") and len(src) <= 512:
        act["buttons"] = [{"label": "Sm3 f YouTube" if "youtu" in src else "Sm3 l original", "url": src}]
    return act


class Presence:
    """Mirrors what you play on any device to your Discord status while this PC is on."""

    def __init__(self, cfg):
        self.sb = Supa(cfg)
        self.rpc = None
        self.app_id = None
        self.enabled = True
        self.last_settings = 0
        self.last = None  # last activity sent (or "none")
        self.extra_ok = True

    def start(self):
        threading.Thread(target=self.loop, daemon=True, name="discord").start()

    def loop(self):
        while True:
            try:
                self.tick()
            except Exception as e:
                log.warning("discord: %s", e)
                self.drop()
                time.sleep(15)
            time.sleep(4)

    def drop(self):
        if self.rpc:
            self.rpc.close()
        self.rpc = None
        self.last = None

    def same(self, a, b):
        if a == b:
            return True
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        if a.get("details") != b.get("details") or a.get("state") != b.get("state"):
            return False
        ta, tb = a.get("timestamps"), b.get("timestamps")
        if bool(ta) != bool(tb):
            return False
        return not ta or abs(ta["start"] - tb["start"]) < 2500  # ignore tiny drift

    def tick(self):
        if time.time() - self.last_settings > 60:
            rows = self.sb.rest("GET", "user_settings?select=discord_app_id,discord_enabled") or []
            st = rows[0] if rows else {}
            new_id = (st.get("discord_app_id") or "").strip() or None
            self.enabled = st.get("discord_enabled", True)
            if new_id != self.app_id:
                self.drop()
                self.app_id = new_id
            self.last_settings = time.time()
        if not self.app_id or not self.enabled:
            if self.rpc:
                self.rpc.set_activity(None)
                self.drop()
            return
        rows = self.sb.rest("GET", "now_playing?select=*") or []
        act = build_activity(rows[0] if rows else None) or "none"
        if self.last is not None and self.same(act, self.last):
            return
        if not self.rpc:
            if act == "none":
                self.last = act
                return
            self.rpc = DiscordIPC(self.app_id)
            self.rpc.connect()
            log.info("Discord connected")
        payload = None if act == "none" else dict(act)
        if payload and not self.extra_ok:
            payload.pop("status_display_type", None)
        try:
            self.rpc.set_activity(payload)
        except ValueError:
            if payload and "status_display_type" in payload:
                self.extra_ok = False
                payload.pop("status_display_type", None)
                self.rpc.set_activity(payload)
            else:
                raise
        self.last = act

LOCK = None


def restart():
    log.info("Restarting to pick up updates")
    global LOCK
    if LOCK:
        LOCK.close()
        LOCK = None
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([sys.executable, str(Path(__file__).resolve())], cwd=str(HERE), creationflags=flags, close_fds=True)
    os._exit(0)


def single_instance():
    for _ in range(20):  # a restarting copy may still hold the port for a moment
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", LOCK_PORT))
            s.listen(1)
            return s
        except OSError:
            s.close()
            time.sleep(0.5)
    return None


def main():
    # pythonw has no console: give libraries somewhere harmless to print
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")
    extend_path()
    if "--cloud" in sys.argv:
        log.addHandler(logging.StreamHandler(sys.stdout))
        sb = Supa({"url": DEFAULT_URL, "key": DEFAULT_KEY,
                   "email": os.environ.get("TARAB_EMAIL") or "cloud",
                   "password": os.environ.get("TARAB_PASSWORD") or None})
        sb.login()
        Worker(sb, cloud=True).run_cloud()
        return
    cfg = load_json(CONFIG, None)
    if not cfg:
        print("config.json missing. Run install.bat again.")
        sys.exit(1)
    sb = Supa(cfg)

    if "--test-login" in sys.argv:
        try:
            sb.login()
            print("OK", sb.uid)
            sys.exit(0)
        except Exception as e:
            print("FAIL", e)
            sys.exit(2)

    global LOCK
    LOCK = single_instance()
    if not LOCK:
        log.info("Already running, exiting")
        return
    script_new = update_script()
    if self_update() or script_new:
        restart()
    log.info("ffmpeg: %s | deno: %s", shutil.which("ffmpeg") or "missing", shutil.which("deno") or "missing")
    while True:
        try:
            sb.login()
            break
        except Exception as e:
            log.warning("login: %s (retry in 60s)", e)
            time.sleep(60)
    Presence(cfg).start()
    Worker(sb).run()


if __name__ == "__main__":
    main()
