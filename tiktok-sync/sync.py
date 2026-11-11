#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "qrcode", "curl_cffi", "rich"]
# ///
"""Imports liked TikToks into memesave over its API.

TikTok signs its web API requests in the browser (msToken, X-Bogus, X-Gnarly), so a real Chromium does the work:
the login is the site's QR login, and the likes are the /api/favorite/item_list/ answers of the profile's Liked tab.
The same session downloads every new like (the video with its cover, or all photos of a carousel) and uploads it
to POST /app/api/upload; a carousel becomes one album. Likes it cannot download go to POST /app/api/import (cobalt).

Environment (also read from .env in the current, the script's and its parent folder):
  MEMESAVE_URL     e.g. https://memereserve.cfb.wtf
  MEMESAVE_TOKEN   API token with write access (Account → Settings → API tokens)
  PROFILE_DIR      browser profile with the TikTok session, default: profile
  STATE_FILE       default: state.json (ids of imported likes)
  INTERVAL         seconds between syncs, default 1800; 0 = run once
  BACKFILL         likes to import on the first run, default 50 (older ones are skipped)
  FULL_BACKFILL    1: save every like of the account first (oldest first, resumable), then sync as usual;
                   waits between likes adapt: shorter while all goes well, down to BACKFILL_PAUSE s (default 10), twice
                   as long after trouble, up to BACKFILL_PAUSE_MAX s (600); so do the rests after every BACKFILL_BATCH
                   (50) likes: from BACKFILL_REST s (900), within BACKFILL_REST_MIN (120) and BACKFILL_REST_MAX (3600)
  BACKFILL_DIR     optional: the full backfill stores the files there (<id>/0.mp4, 0.jpg, …, meta.json with the upload
                   fields) instead of uploading them, without the memesave size limits
  RETRY_FAILED     1: the full backfill tries the likes in BACKFILL_DIR stored without files (meta.json with an error) again
  LOG_FILE         log of the full backfill in a terminal (it shows its progress there), default sync.log
  DOWNLOAD_THREADS most parallel downloads of the full backfill, default 8 (the count adapts to errors)
  CHROMIUM         optional: path of a Chromium/Chrome binary instead of the playwright one
  NOCAPTCHAAI_KEY  optional: nocaptchaai.com key, solves the rotate captcha (else it is closed)
  HEADLESS         0 runs a normal browser window, default 1. TikTok rejects even right captcha answers from
                   headless Chromium and shows it captchas more often: on a server use HEADLESS=0 xvfb-run -a ./sync.py

Usage:
  uvx playwright install chromium   once, or set CHROMIUM
  ./sync.py login   log in: scan the QR code in the TikTok app (Profile → ☰ → scanner) and confirm
  ./sync.py         sync (or uv run sync.py)
"""

import asyncio
import json
import os
import random
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter, deque
from concurrent.futures import Future
from contextlib import contextmanager, nullcontext
from pathlib import Path

from curl_cffi.requests import AsyncSession
from playwright.sync_api import Error as PlaywrightError, sync_playwright
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
CLIENT_UA = "memesave-tiktok-sync/1.0"  # Cloudflare blocks the urllib default (error 1010)
SEEN_MAX = 200_000  # ids of saved likes kept in the state (all of them for a full backfill)
SYNC_MAX = 5000  # likes are newest first: the first seen one ends a sync
LOGIN_WAIT = 300  # seconds
IDLE_SCROLLS = 6  # scrolls without new likes before the list counts as loaded
NOCAPTCHA = "https://api.nocaptchaai.com"
CAPTCHA_TRIES = 3
PHOTO_MAX, VIDEO_MAX, THUMB_MAX = 10 << 20, 50 << 20, (1 << 20) - 1  # memesave upload limits


def first_line(e):
    """The message of an error without Playwright's call log (it holds the request headers with the session cookies)."""
    return str(e).splitlines()[0] if str(e) else type(e).__name__


def load_env():
    """KEY=value lines of .env files; the real environment wins."""
    here = Path(__file__).resolve().parent
    for path in (Path(".env"), here / ".env", here.parent / ".env"):
        if path.is_file():
            for line in path.read_text().splitlines():
                key, sep, value = line.strip().partition("=")
                if sep and not key.startswith("#"):
                    os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        sys.exit(f"{name} is not set")
    return value


def drop_stale_lock(profile):
    """Chromium refuses a profile locked by a browser that was killed (e.g. with its container); the lock names
    "<host>-<pid>" of the owner."""
    lock = Path(profile) / "SingletonLock"
    if not lock.is_symlink():
        return
    host, _, pid = os.readlink(lock).rpartition("-")
    if host == socket.gethostname() and Path(f"/proc/{pid}").exists():
        return  # a running browser
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        (Path(profile) / name).unlink(missing_ok=True)


def browser(p):
    drop_stale_lock(os.environ.get("PROFILE_DIR", "profile"))
    return p.chromium.launch_persistent_context(
        os.environ.get("PROFILE_DIR", "profile"),
        executable_path=os.environ.get("CHROMIUM") or None,
        headless=os.environ.get("HEADLESS", "1") != "0",
        user_agent=UA,
        locale="en-US",
        viewport={"width": 1280, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )


def logged_in(ctx):
    return any(c["name"] == "sessionid" and c["value"] for c in ctx.cookies("https://www.tiktok.com"))


def show_qr(link):
    import qrcode

    qr = qrcode.QRCode(border=2)
    qr.add_data(link)
    qr.print_ascii(invert=True)


def login():
    """Opens the QR login, prints each QR code (it is renewed when it expires) and waits for the confirmation."""
    with sync_playwright() as p:
        ctx = browser(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_response(res):
            # The page shortens the scan link of get_qrcode (www.tiktok.com/t/…) and draws the QR code of it.
            if "/shorten/" in res.url:
                try:
                    short = res.json()["data"][0]
                    if "/passport/web/scan_index/" not in short["target"]:
                        return
                    link = short["short_url"]
                    show_qr(link)
                    print(link)
                    print("Scan it in the TikTok app: Profile → ☰ → scanner, then confirm.")
                except Exception as e:  # noqa: BLE001
                    print(f"no QR code: {e}", file=sys.stderr)

        page.on("response", on_response)
        page.goto("https://www.tiktok.com/login/qrcode")
        deadline = time.time() + LOGIN_WAIT
        while not logged_in(ctx):
            if time.time() > deadline:
                sys.exit("login timed out")
            page.wait_for_timeout(2000)
        ctx.close()
    print("logged in")


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": CLIENT_UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {e.read().decode(errors='replace')[:300]}") from None


def nocaptcha(task, timeout=60):
    """Solution of a nocaptchaai.com task (createTask, then getTaskResult until ready)."""
    key = os.environ["NOCAPTCHAAI_KEY"]
    created = post_json(f"{NOCAPTCHA}/createTask", {"clientKey": key, "task": task})
    if created.get("errorId"):
        raise RuntimeError(f"nocaptchaai: {created}")
    if created.get("status") == "ready":  # image tasks are answered at once
        return created["solution"]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(2)
        res = post_json(f"{NOCAPTCHA}/getTaskResult", {"clientKey": key, "taskId": created["taskId"]})
        if res.get("status") == "ready":
            return res["solution"]
        if res.get("status") == "failed" or res.get("errorId"):
            raise RuntimeError(f"nocaptchaai: {res}")
    raise RuntimeError("nocaptchaai: timed out")


def angle_of(img):
    return float(re.search(r"rotate\((-?[\d.]+)deg", img.get_attribute("style") or "rotate(0deg)").group(1))


def solve_rotate(page, outer, inner):
    """Rotate captcha: the API gives the angle; the slider moves until the inner image is turned that far."""
    b64 = lambda img: img.get_attribute("src").split(",", 1)[1]
    solution = nocaptcha(
        {
            "type": "TiktokClassification",
            "images": [b64(outer)],
            "examples": [b64(inner)],
            "question": "tiktok_slide:Rotate the image to the correct angle",
            "websiteURL": page.url,
        }
    )
    target = (solution["slide"] if isinstance(solution, dict) else solution)[0][0]  # docs: {"slide": [[a]]}, API: [[a]]
    box = page.locator("#captcha_slide_button").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 10, y + 1, steps=3)
    per_px = abs(angle_of(inner)) / 10 or 0.6  # degrees of the inner image per pixel
    dist = target / per_px
    steps = random.randint(25, 40)
    for i in range(1, steps + 1):  # a hand: fast start, slow end, a little shake
        page.mouse.move(x + 10 + (dist - 10) * (1 - (1 - i / steps) ** 3), y + random.uniform(-2, 2))
        page.wait_for_timeout(random.randint(10, 35))
    pos = x + dist
    for _ in range(30):  # small corrections to the exact angle
        err = target - abs(angle_of(inner))
        if abs(err) < 0.7:
            break
        pos += max(-2.0, min(2.0, err / per_px))
        page.mouse.move(pos, y + random.uniform(-1, 1))
        page.wait_for_timeout(random.randint(30, 60))
    page.wait_for_timeout(random.randint(200, 400))
    page.mouse.up()


def handle_captcha(page):
    """TikTok shows captchas to the headless browser: the rotate one is solved with NOCAPTCHAAI_KEY;
    any other one (or a failed solve) is closed, and the likes load anyway."""
    for _ in range(CAPTCHA_TRIES if os.environ.get("NOCAPTCHAAI_KEY") else 0):
        imgs = page.locator("#captcha-verify-container-main-page img").all()
        if len(imgs) != 2 or "rotate(" not in (imgs[1].get_attribute("style") or ""):
            break  # no captcha, or not the rotate one
        try:
            solve_rotate(page, *imgs)
        except Exception as e:  # noqa: BLE001 - closing still works
            print(f"captcha not solved: {first_line(e)}", file=sys.stderr)
            break
        page.wait_for_timeout(3000)  # a wrong answer brings a new captcha
    close = page.locator("#captcha_close_button")
    if close.count():
        close.click()
        page.wait_for_timeout(1500)


def stamp(data, prev):
    """The items of an item_list answer with their like time: the cursor of a page is the like time (ms) of its last
    item; the items between it and the previous page (or now) are spread evenly, but not before the post itself."""
    page_items, cursor = data.get("itemList") or [], int(data.get("cursor") or 0)
    prev = prev or time.time() * 1000
    for i, item in enumerate(page_items):
        at = prev - (prev - cursor) * (i + 1) / len(page_items) if cursor else None
        item["_saved_at"] = max(int(at / 1000), item.get("createTime") or 0) if at else None
    return page_items


def new_likes(page, seen, limit, idle_max=IDLE_SCROLLS):
    """Likes after the newest seen one, newest first, at most `limit`, and whether the list ended:
    scrolls the Liked tab and reads its API answers."""
    items, state = {}, {"more": True, "cursor": None}  # dict: answers may repeat, insertion keeps the order

    def on_response(res):
        if "/api/favorite/item_list" not in res.url:
            return
        try:
            data = res.json()
        except Exception:  # noqa: BLE001 - an empty anti-bot answer
            return
        for item in stamp(data, state["cursor"]):
            items.setdefault(item["id"], item)
        state["more"], state["cursor"] = bool(data.get("hasMore")), int(data.get("cursor") or 0) or state["cursor"]

    page.on("response", on_response)
    info = page.request.get("https://www.tiktok.com/passport/web/account/info/?aid=1459").json()
    username = (info.get("data") or {}).get("username")
    if not username:
        raise RuntimeError(f"no account info (session expired? run login): {info}")
    page.goto(f"https://www.tiktok.com/@{username}")
    page.wait_for_timeout(5000)  # the captcha comes after the page
    handle_captcha(page)
    page.locator('[data-e2e="liked-tab"]').click(timeout=30_000)

    idle, count = 0, 0
    while state["more"] and idle < idle_max and len(items) < limit and not seen.intersection(items):
        handle_captcha(page)
        page.mouse.wheel(0, 5000)
        page.wait_for_timeout(1500)
        idle = idle + 1 if len(items) == count else 0
        count = len(items)
    page.remove_listener("response", on_response)

    found = []
    for item in items.values():
        if item["id"] in seen:
            break
        found.append(item)
    return found[:limit], not state["more"]


def fetch(page, urls, mime, limit):
    """Bytes and type of a TikTok CDN file, with the session's cookies (the CDN needs them); tries each mirror URL."""
    error = "no URL"
    for url in filter(None, urls):
        res = page.request.get(url, headers={"Referer": "https://www.tiktok.com/"}, timeout=120_000)
        body = res.body() if res.ok else b""
        if not res.ok or len(body) > limit:  # a smaller mirror may follow
            error = f"HTTP {res.status} {url[:80]}" if not res.ok else f"too large: {len(body)} bytes"
            continue
        return body, kind(res.headers.get("content-type", ""), mime)
    raise RuntimeError(error)


class Throttled(RuntimeError):
    """A 429 or 5xx answer of the CDN: a reason to slow down, unlike a dead link."""

    def __init__(self, message, retry_after=None):
        super().__init__(message)
        self.retry_after = float(retry_after) if (retry_after or "").isdigit() else 0.0


async def afetch(s, urls, mime, limit, dest=None, row=None):
    """fetch with a curl_cffi session; with dest, the file streams there (no big file in memory) and its path comes
    back instead of the bytes. row gets the progress: got and total bytes, t0 (start)."""
    error, row = "no URL", {} if row is None else row
    for url in filter(None, urls):
        res = await s.get(url, headers={"Referer": "https://www.tiktok.com/"}, timeout=(15, 60), stream=True)
        try:
            if res.status_code == 429 or res.status_code >= 500:
                raise Throttled(f"HTTP {res.status_code} {url[:80]}", res.headers.get("retry-after"))
            if res.status_code >= 400:
                error = f"HTTP {res.status_code} {url[:80]}"
                continue
            size, chunks = 0, []
            row.update(got=0, total=int(res.headers.get("content-length") or 0), t0=time.time())
            with open(dest, "wb") if dest else nullcontext() as f:
                async for chunk in res.aiter_content():
                    size += len(chunk)
                    row["got"] = size
                    if size > limit:
                        break
                    f.write(chunk) if f else chunks.append(chunk)
            if size > limit:
                error = f"too large: over {limit} bytes"
                continue
            return dest or b"".join(chunks), kind(res.headers.get("content-type") or "", mime)
        finally:
            await res.aclose()
    raise RuntimeError(error)


def kind(got, mime):
    got = got.split(";")[0]
    return got if got.startswith(mime.split("/")[0] + "/") else mime


def video_urls(v):
    """Mirrors of a video, best first: H.264 by bitrate (bitrateInfo, as yt-dlp), playAddr, H.265, downloadAddr
    (watermarked). A slim item keeps the list."""
    if "urls" in v:
        return v["urls"]
    rates = sorted(v.get("bitrateInfo") or [], key=lambda b: -(b.get("Bitrate") or 0))
    play = lambda h264: [u for b in rates if (b.get("CodecType") == "h264") == h264 for u in (b.get("PlayAddr") or {}).get("UrlList") or []]
    return list(dict.fromkeys(filter(None, play(True) + [v.get("playAddr")] + play(False) + [v.get("downloadAddr")])))


def like_plan(item, limited=True):
    """[(fields, {name: (urls, mime, limit)})] of the upload fields of a liked post: every photo of a carousel (JPEG
    first), or the video with its cover (as cobalt does). The cover (thumb) is the preview of the video in memesave and
    may fail: originCover is a small JPEG, cover may be a big PNG. Not limited: no memesave upload limits (a folder)."""
    PHOTO, VIDEO, THUMB = (PHOTO_MAX, VIDEO_MAX, THUMB_MAX) if limited else (float("inf"),) * 3
    images = (item.get("imagePost") or {}).get("images")
    if images:
        jpeg_first = lambda img: sorted(img["imageURL"]["urlList"], key=lambda u: ".jpeg?" not in u)
        return [({"width": img.get("imageWidth"), "height": img.get("imageHeight")}, {"file": (jpeg_first(img), "image/jpeg", PHOTO)}) for img in images]
    v = item["video"]
    parts = {"thumb": ([v.get("originCover"), v.get("cover")], "image/jpeg", THUMB), "file": (video_urls(v), "video/mp4", VIDEO)}
    return [({k: v.get(k) for k in ("width", "height", "duration")}, parts)]


def like_files(page, item, limited=True):
    """The upload fields of a like, downloaded in the browser session."""
    for fields, parts in (plan := like_plan(item, limited)):
        for name, (urls, mime, limit) in parts.items():
            try:
                fields[name] = fetch(page, urls, mime, limit)
            except Exception:  # noqa: BLE001
                if name != "thumb":
                    raise
    return [fields for fields, _ in plan]


async def alike_files(s, item, folder=None, row=None):
    """like_files with a curl_cffi session; with a folder, the files stream to <folder>/<id>/*.part (paths, not bytes).
    row gets the progress (see afetch) and the part on the way."""
    if folder:
        (folder / item["id"]).mkdir(parents=True, exist_ok=True)
    row = {} if row is None else row
    for n, (fields, parts) in enumerate(plan := like_plan(item, not folder)):
        for name, (urls, mime, limit) in parts.items():
            row["part"] = ("cover" if name == "thumb" else "photo" if mime.startswith("image/") else "video") + (f" {n + 1}/{len(plan)}" if len(plan) > 1 else "")
            try:
                fields[name] = await afetch(s, urls, mime, limit, folder and folder / item["id"] / f"{n}.{name}.part", row)
            except Exception:  # noqa: BLE001
                if name != "thumb":
                    raise
    return [fields for fields, _ in plan]


def api(path, body, content_type):
    """True when memesave took the request; raises on errors that stop the sync (auth, payment)."""
    req = urllib.request.Request(
        env("MEMESAVE_URL").rstrip("/") + path,
        data=body,
        headers={"Authorization": f"Bearer {env('MEMESAVE_TOKEN')}", "Content-Type": content_type, "User-Agent": CLIENT_UA},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120):
            return True
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")[:300]
        if e.code in (401, 402, 403):
            raise RuntimeError(f"memesave: HTTP {e.code} {text}")
        if e.code == 409:  # already saved
            return True
        print(f"memesave {path} failed: HTTP {e.code} {text}", file=sys.stderr)
        return False


def upload(fields):
    """POST /app/api/upload as multipart; (bytes, type) values are files."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        if value is None:
            continue
        if isinstance(value, tuple):
            head = f'Content-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: {value[1]}'
            parts.append(f"--{boundary}\r\n{head}\r\n\r\n".encode() + value[0] + b"\r\n")
        else:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    return api("/app/api/upload", b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}")


def save_like(page, item, folder=None, files=None):
    """Uploads the files of a like (a carousel as one album); falls back to the link import through cobalt.
    With a folder, stores them there instead (<folder>/<like id>/), for an import later."""
    url = f"https://www.tiktok.com/@{item['author']['uniqueId']}/video/{item['id']}"
    try:
        files = files or like_files(page, item, not folder)
    except Exception as e:  # noqa: BLE001 - cobalt may still get it
        print(f"download failed: {url}: {first_line(e)}", file=sys.stderr)
        if folder:
            store_like(folder / item["id"], item, url, [], first_line(e))
            return True
        return api("/app/api/import", json.dumps({"url": url}).encode(), "application/json")
    if folder:
        store_like(folder / item["id"], item, url, files)
        return True
    album = f"tiktok:{item['id']}" if len(files) > 1 else None
    meta = {"source": url, "saved_at": item.get("_saved_at"), "album": album}
    return all(upload({**f, **meta, "position": i}) for i, f in enumerate(files))


EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "video/mp4": "mp4"}


def put(target, body):
    """Writes the bytes of a file, or moves a streamed one (a path) there."""
    target.write_bytes(body) if isinstance(body, bytes) else os.replace(body, target)


def store_like(path, item, url, files, error=None):
    """<path>/0.mp4 (+ 0.thumb.jpg) or 0.jpg, 1.jpg, … and meta.json: the fields of POST /app/api/upload per file."""
    path.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, f in enumerate(files):
        entry = {"position": i, "file": f"{i}.{EXT.get(f['file'][1], 'bin')}", "mime": f["file"][1]}
        put(path / entry["file"], f["file"][0])
        if f.get("thumb"):
            entry["thumb"] = f"{i}.thumb.{EXT.get(f['thumb'][1], 'jpg')}"
            put(path / entry["thumb"], f["thumb"][0])
        entries.append({**entry, **{k: f.get(k) for k in ("width", "height", "duration")}})
    meta = {
        "id": item["id"],
        "source": url,
        "saved_at": item.get("_saved_at"),
        "created_at": int(item.get("createTime") or 0) or None,  # the post itself
        "author": item["author"]["uniqueId"],
        "desc": item.get("desc"),
        "album": f"tiktok:{item['id']}" if len(files) > 1 else None,
        "files": entries,
        "error": error,  # no files: import the source link instead
    }
    (path / "meta.json.tmp").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(path / "meta.json.tmp", path / "meta.json")  # a crash leaves no half meta.json


def load_state(path):
    """{"seen": ids of saved likes, "queue": [id, like time] left for the full backfill, oldest first, "backfill_done": true}."""
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def write_json(path, data):
    with open(path + ".tmp", "w") as f:
        json.dump(data, f)
    os.replace(path + ".tmp", path)


def save_state(path, state):
    state["seen"] = state["seen"][-SEEN_MAX:]
    write_json(path, state)


@contextmanager
def session():
    """The page of a logged-in browser."""
    with sync_playwright() as p:
        ctx = browser(p)
        try:
            if not logged_in(ctx):
                sys.exit("not logged in: run ./sync.py login")
            yield ctx.pages[0] if ctx.pages else ctx.new_page()
        finally:
            try:
                ctx.close()
            except Exception:  # noqa: BLE001 - Ctrl+C on Windows stops the Playwright driver too
                pass


def sync(path):
    state = load_state(path)
    first = state is None
    state = state or {"seen": []}
    with session() as page:
        # The first run imports the newest BACKFILL likes (at least one is read: it marks where the next sync stops).
        likes, _ = new_likes(page, set(state["seen"]), max(1, int(os.environ.get("BACKFILL", "50"))) if first else SYNC_MAX)
        imports = int(os.environ.get("BACKFILL", "50")) if first else len(likes)
        # Oldest first, so the library keeps the like order.
        for i, item in reversed(list(enumerate(likes))):
            if i < imports and not save_like(page, item):
                break  # newer likes stay unseen: the next sync retries from this one
            state["seen"].append(item["id"])
            save_state(path, state)
    print(f"synced: {min(len(likes), imports)} new likes")


def post_data(html):
    """The post in a TikTok post page (what cobalt reads); None when it is gone, KeyError/ValueError without data."""
    raw = html.split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1].split("</script>")[0]
    detail = json.loads(raw)["__DEFAULT_SCOPE__"]["webapp.video-detail"]
    item = (detail.get("itemInfo") or {}).get("itemStruct")
    return None if detail.get("statusMsg") or not item or not item.get("author") else item


def like_post(page, like_id):
    """A like with fresh CDN links: its page without the browser, or opened in it when the captcha is in the way;
    and whether TikTok held the plain request back."""
    url = f"https://www.tiktok.com/@i/video/{like_id}"
    try:
        return post_data(page.request.get(url, timeout=60_000).text()), False
    except (IndexError, KeyError, ValueError):
        page.goto(url)
        page.wait_for_timeout(5000)
        handle_captcha(page)
        return post_data(page.content()), True


class Pacer:
    """Waits of the full backfill, AIMD: the wait between likes gets a little shorter after each saved like and twice
    as long after trouble (a timeout, a held-back request); the rest after a batch gets shorter after a calm batch
    and twice as long after one with trouble. Bounds: BACKFILL_PAUSE(_MAX), BACKFILL_REST_MIN/MAX."""

    def __init__(self, low, high, rest, rest_low, rest_high):
        self.low, self.high, self.delay = low, high, low * 2
        self.rest, self.rest_low, self.rest_high, self.calm = rest, rest_low, rest_high, True

    def ok(self):
        self.delay = max(self.low, self.delay * 0.9)

    def trouble(self, why):
        self.delay, self.calm = min(self.high, self.delay * 2), False
        print(f"backfill: {why}; waiting {self.delay:.0f} s between likes now", file=sys.stderr)

    def next_rest(self):
        self.rest = max(self.rest_low, self.rest * 0.7) if self.calm else min(self.rest_high, self.rest * 2)
        self.calm = True
        return self.rest


class LogFile:
    """A text stream for print(): each line goes to the file with the time, and to `tail`."""

    def __init__(self, path, tail):
        self.f, self.tail, self.buf, self.lock = open(path, "a", encoding="utf-8"), tail, "", threading.Lock()

    def write(self, s):
        with self.lock:
            *lines, self.buf = (self.buf + s).split("\n")
            for line in filter(str.strip, lines):
                line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}"
                self.f.write(line + "\n")
                self.tail.append(line)
            self.f.flush()
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


def smooth_speed(r, every=0.25, keep=0.8):
    """MB/s of a download row (see afetch), an exponential mean over samples every 0.25 s: smooth, but it follows."""
    now, got = time.time(), r["got"]
    if r.get("_t0") != r["t0"] or got < r.get("_got", 0):  # a new part
        r.update(_t0=r["t0"], _t=r["t0"], _got=0, _v=0.0)
    if now - r["_t"] >= every:
        r["_v"] = keep * r["_v"] + (1 - keep) * (got - r["_got"]) / (now - r["_t"]) if r["_v"] else (got - r["_got"]) / (now - r["_t"])
        r["_t"], r["_got"] = now, got
    return r["_v"] / 2**20


class Tui:
    """The progress of the backfill in the terminal (rich). The log lines go to LOG_FILE (default sync.log) and the last
    ones show under the progress. Without a terminal (a service) the lines go to the output as before."""

    def __init__(self):
        self.total = self.done = self.base = 0  # base: done before this run
        self.counts, self.status, self.downloader, self.started, self.tail = Counter(), "starting", None, time.time(), deque(maxlen=8)

    def __enter__(self):
        if sys.stdout.isatty():
            self.out, self.log = (sys.stdout, sys.stderr), LogFile(os.environ.get("LOG_FILE", "sync.log"), self.tail)
            sys.stdout = sys.stderr = self.log
            console = Console(file=self.out[0])
            self.live = Live(get_renderable=self.render, console=console, refresh_per_second=15, redirect_stdout=False, redirect_stderr=False)
            self.live.start()
        return self

    def __exit__(self, *exc):
        if hasattr(self, "live"):
            self.live.stop()
            sys.stdout, sys.stderr = self.out
            self.log.f.close()

    def render(self):
        rate = (self.done - self.base) / max(1, time.time() - self.started)
        eta = (self.total - self.done) / rate if rate else 0
        bar = Table.grid(padding=(0, 2))
        bar.add_row(ProgressBar(total=self.total or None, completed=self.done, width=40), f"{self.done}/{self.total} ({self.done * 100 // max(1, self.total)}%)  {rate * 3600:.0f}/h  ETA {eta // 3600:.0f} h {eta % 3600 // 60:.0f} min")
        grid = Table.grid(padding=(0, 2))
        grid.add_column(style="bold")
        grid.add_row("Likes", bar)
        grid.add_row("Saved", "  ".join(f"{k}: {v}" for k, v in self.counts.items()) or "-")
        if d := self.downloader:
            ahead = sum(job.done() for job in list(d.jobs.values()))
            grid.add_row("Downloads", f"{int(d.parallel)} parallel, {d.running} running, {ahead} ready ahead, wait {d.wait:.0f} s, {d.bytes / 2**20:.0f} MB")
        grid.add_row("Now", self.status)
        log = [Text(line, style="dim", no_wrap=True, overflow="ellipsis") for line in list(self.tail)]
        panels = [Panel(grid, title="TikTok backfill")]
        if d:  # a fixed row per slot and fixed columns: the rows do not move
            rows = Table.grid(padding=(0, 2))
            for width, justify in ((19, "left"), (10, "left"), (30, "left"), (17, "right"), (10, "right")):
                rows.add_column(width=width, justify=justify, no_wrap=True)
            for slot in list(d.slots):
                if not slot:
                    rows.add_row(Text("idle", style="dim"), "", "", "", "")
                    continue
                like_id, r = slot
                speed = smooth_speed(r)
                size = f"{r['got'] / 2**20:.1f}/{r['total'] / 2**20:.1f} MB" if r["total"] else f"{r['got'] / 2**20:.1f} MB"
                rows.add_row(like_id, r["part"], ProgressBar(total=r["total"] or None, completed=r["got"], width=30), size, f"{speed:.1f} MB/s")
            panels.append(Panel(rows, title=f"Downloads ({sum(map(bool, d.slots))})"))
        return Group(*panels, *log)


def pause(seconds):
    time.sleep(seconds * random.uniform(0.5, 1.5))


def env_int(name, default):
    return int(os.environ.get(name, default))


def backfill(path, tui):
    """FULL_BACKFILL: saves every like of the account, oldest first, in batches with pauses; resumes from STATE_FILE.
    Every batch gets a fresh browser: a long-running one keeps growing."""
    state = load_state(path) or {"seen": []}
    batch = env_int("BACKFILL_BATCH", 50)
    pacer = Pacer(
        env_int("BACKFILL_PAUSE", 10), env_int("BACKFILL_PAUSE_MAX", 600),
        env_int("BACKFILL_REST", 900), env_int("BACKFILL_REST_MIN", 120), env_int("BACKFILL_REST_MAX", 3600),
    )  # fmt: skip
    folder = Path(os.environ["BACKFILL_DIR"]) if os.environ.get("BACKFILL_DIR") else None
    cache_path = path + ".likes.json"  # the like list with its CDN links: no post page while they last
    if "queue" not in state:
        tui.status = "listing the likes"
        with session() as page:
            seen = set(state["seen"])
            state["queue"] = [[i["id"], i["_saved_at"]] for i in reversed(all_likes(page, cache_path)) if i["id"] not in seen]
        save_state(path, state)
    cache = {i["id"]: i for i in (load_state(cache_path) or {"items": []})["items"]}
    if folder:  # stored likes that fail the offline check (with RETRY_FAILED: or have no files) are downloaded again
        retry, ids, broken = os.environ.get("RETRY_FAILED") == "1", [i for i in cache if (folder / i).is_dir()], set()
        for n, i in enumerate(ids):
            tui.status = f"checking the stored likes: {n + 1}/{len(ids)}"
            if not (stored(folder, i) and whole_like(folder / i)) or retry and failed(folder, i):
                broken.add(i)
                (folder / i / "meta.json").unlink(missing_ok=True)  # not stored any more
        print(f"check: {len(ids) - len(broken)} of {len(ids)} stored likes are whole, {len(broken)} are downloaded again")
        state["queue"][:0] = [[i, cache[i]["_saved_at"]] for i in state["seen"] if i in broken]
        state["seen"] = [i for i in state["seen"] if i not in broken]
    done = len(state["seen"])
    total = done + len(state["queue"])
    print(f"backfill: {len(state['queue'])} of {total} likes left")
    downloader = Downloader(env_int("DOWNLOAD_THREADS", 8), folder)
    tui.total, tui.done, tui.base, tui.started, tui.downloader = total, done, done, time.time(), downloader
    page_at = 0.0  # no post page before: the waits pace only the post pages, not the downloaded likes
    while state["queue"]:
        slow = 0  # post pages opened in this batch: only they need the waits
        with session() as page:
            if not downloader.task:
                downloader.start(page.context.cookies(), state["queue"], cache)
            for n in range(min(batch, len(state["queue"]))):
                like_id, saved_at = state["queue"][0]
                tui.status = f"waiting for the download of {like_id}"
                got = downloader.take(like_id)  # files, or True: stored by the downloader
                was_stored = not got and stored(folder, like_id)
                item, files = cache.get(like_id) if got else None, got if isinstance(got, list) else None
                held_back = None  # None: no post page opened
                if not (was_stored or got) and page_at > time.time():
                    tui.status = f"next post page ({like_id}) at {time.strftime('%H:%M:%S', time.localtime(page_at))}"
                    time.sleep(max(0.0, page_at - time.time()))
                for attempt in range(1, 4) if not (was_stored or got) else ():  # network hiccups: wait and retry
                    try:
                        tui.status = f"post page of {like_id}"
                        item, held_back = like_post(page, like_id)
                        break
                    except (IndexError, KeyError, ValueError):
                        raise RuntimeError(f"no post data for {like_id} (captcha?)") from None
                    except PlaywrightError as e:
                        if attempt == 3:
                            raise
                        pacer.trouble(f"{like_id}: {first_line(e)}")
                        pause(pacer.delay)
                if held_back:
                    pacer.trouble(f"{like_id}: the post page needed the browser")
                elif held_back is False:
                    pacer.ok()
                if item and got is not True and not save_like(page, {**item, "_saved_at": saved_at}, folder, files):
                    return  # the next run retries this like
                state["seen"].append(state["queue"].pop(0)[0])
                save_state(path, state)
                done += 1
                tui.done = done
                how = "stored before" if was_stored else "gone" if not item else "cache" if got else "post page"
                tui.counts[how] += 1
                print(f"backfill: {done}/{total} ({done * 100 // total}%) {like_id}: {how}, {int(downloader.parallel)} parallel")
                slow += held_back is not None
                if held_back is not None:
                    page_at = time.time() + pacer.delay * random.uniform(0.5, 1.5)
        if state["queue"] and slow:
            rest = pacer.next_rest()
            page_at = max(page_at, time.time() + rest * random.uniform(0.5, 1.5))
            print(f"backfill: {done} saved, {len(state['queue'])} left; {pacer.delay:.0f} s between post pages, the next one in about {rest:.0f} s")
    state.pop("queue")
    state["backfill_done"] = True
    save_state(path, state)
    Path(cache_path).unlink(missing_ok=True)
    tui.status = "done"
    print("backfill: done")


def slim(item):
    """The fields of a like that saving it needs (with its CDN links)."""
    v = item.get("video") or {}
    return {
        **{k: item.get(k) for k in ("id", "createTime", "desc", "imagePost", "_saved_at")},
        "author": {"uniqueId": item["author"]["uniqueId"]},
        "video": {**{k: v.get(k) for k in ("originCover", "cover", "width", "height", "duration")}, "urls": video_urls(v)},
    }


def fresh(item, margin=300):
    """False when a CDN link of a cached like expires soon (expire= of videos, x-expires= of photos)."""
    urls = video_urls(item["video"]) + [u for img in (item.get("imagePost") or {}).get("images") or [] for u in img["imageURL"]["urlList"]]
    times = [int(t) for u in filter(None, urls) for k, t in urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query) if k in ("expire", "x-expires")]
    return min(times, default=float("inf")) > time.time() + margin


def whole_like(path):
    """Offline check of a stored like: its meta.json and every file it names are whole."""
    try:
        meta = json.loads((path / "meta.json").read_text(encoding="utf-8"))
        return all(whole(path / f[k]) for f in meta["files"] for k in ("file", "thumb") if f.get(k))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def whole(file):
    """False for a cut or wrong file: the boxes of an MP4 (or HEIC) fill it and hold moov (meta), a JPEG ends with its
    end marker after its scan, a PNG with IEND, a WebP has its RIFF size. Other types only must not be empty."""
    with open(file, "rb") as f:
        size, head = os.fstat(f.fileno()).st_size, f.read(12)
        if head[4:8] == b"ftyp":
            pos, boxes = 0, set()
            while pos < size:
                f.seek(pos)
                box = f.read(16)
                n = int.from_bytes(box[:4], "big") if len(box) >= 8 else 0
                n = int.from_bytes(box[8:16], "big") if n == 1 else n  # 64-bit size
                n = size - pos if n == 0 and len(box) >= 8 else n  # 0: up to the end
                if n < 8:
                    return False
                boxes.add(box[4:8])
                pos += n
            return pos == size and bool(boxes & {b"moov", b"meta"})
        if head[:3] == b"\xff\xd8\xff":  # the end marker after the scan (SOS); a trailer (SEFT, wtmk) may follow
            data, pos = head + f.read(), 2
            while pos + 4 <= len(data) and data[pos] == 0xFF and data[pos + 1] != 0xDA:
                pos += 2 + int.from_bytes(data[pos + 2 : pos + 4], "big")
            return data[pos : pos + 2] == b"\xff\xda" and data.rfind(b"\xff\xd9") > pos
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            f.seek(max(0, size - 8))
            return f.read(4) == b"IEND"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return int.from_bytes(head[4:8], "little") + 8 == size
        return size > 0


def failed(folder, like_id):
    """Stored without files: meta.json holds the error."""
    return bool(json.loads((folder / like_id / "meta.json").read_text(encoding="utf-8")).get("error"))


def stored(folder, like_id):
    """Saved to the folder by an earlier run."""
    meta = folder and folder / like_id / "meta.json"
    return bool(meta) and meta.is_file() and meta.stat().st_size > 0  # empty: an old crash while writing it


class Downloader:
    """Downloads the cached likes in the background, oldest first, with the links of the like list while they last and
    independent of the backfill's waits: asyncio in its own thread with curl_cffi (the TLS fingerprint of Chrome).
    With a folder it stores them at once; else it keeps at most 4 × DOWNLOAD_THREADS for the backfill to upload.
    AIMD: about one more parallel download after each `parallel` without trouble (up to DOWNLOAD_THREADS) and shorter
    waits before each; after a 429, 5xx or network error one at a time and 4× the wait (5 to 300 s, at least
    Retry-After), up to 3 tries. A dead link (403, 404) is no reason to slow down: its like goes to the post page."""

    def __init__(self, high, folder):
        self.high, self.folder, self.parallel, self.wait, self.running = high, folder, 1.0, 0.0, 0
        self.jobs, self.passed, self.task = {}, set(), None  # passed: likes the downloader started or skipped
        self.tasks, self.bytes = set(), 0  # tasks: references, else asyncio may drop a running one
        self.slots = [None] * high  # (like id, progress of its download (see afetch)) or None: a TUI row each
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def start(self, cookies, queue, cache):
        self.task = asyncio.run_coroutine_threadsafe(self.run(cookies, list(queue), cache), self.loop)

    async def run(self, cookies, queue, cache):
        try:
            async with AsyncSession(impersonate="chrome", max_clients=self.high) as s:
                for c in cookies:
                    s.cookies.set(c["name"], c["value"], domain=c["domain"])
                for like_id, _ in queue:
                    while self.running >= int(self.parallel) or (not self.folder and len(self.jobs) >= self.high * 4):
                        await asyncio.sleep(0.2)
                    item = cache.get(like_id)
                    if item and fresh(item) and not stored(self.folder, like_id):
                        self.jobs[like_id], self.running = Future(), self.running + 1
                        task = asyncio.create_task(self.one(s, item, self.jobs[like_id]))
                        self.tasks.add(task)
                        task.add_done_callback(self.tasks.discard)
                    self.passed.add(like_id)
                while self.running:
                    await asyncio.sleep(0.5)
        except Exception as e:  # noqa: BLE001 - the backfill goes on with the post pages
            print(f"downloader stopped: {first_line(e)}", file=sys.stderr)

    async def one(self, s, item, job):
        row, slot = {"part": "waiting", "got": 0, "total": 0, "t0": time.time()}, self.slots.index(None)  # running ≤ high
        self.slots[slot] = item.get("id"), row
        try:
            for attempt in range(1, 4):  # a 429, 5xx or network error: slow down and retry; a dead link goes to the post page
                row["part"] = "waiting"
                await asyncio.sleep(self.wait * random.uniform(0.5, 1.5))
                try:
                    files = await alike_files(s, item, self.folder, row)
                    break
                except (Throttled, OSError) as e:  # OSError: the network errors of curl_cffi
                    self.parallel, self.wait = 1.0, min(300.0, max(5.0, self.wait * 4, getattr(e, "retry_after", 0)))
                    print(f"downloader: {item['id']}: {first_line(e)}; one at a time, waiting {self.wait:.0f} s", file=sys.stderr)
                    if attempt == 3:
                        raise
            self.bytes += sum(len(b) if isinstance(b, bytes) else b.stat().st_size for f in files for b, _ in filter(None, (f.get("file"), f.get("thumb"))))
            if self.folder:
                await asyncio.to_thread(save_like, None, item, self.folder, files)
                files = True
            self.parallel, self.wait = min(self.high, self.parallel + 1 / self.parallel), self.wait * 0.8 if self.wait > 0.1 else 0.0
            job.set_result(files)
        except Exception as e:  # noqa: BLE001
            job.set_exception(e)
        finally:
            self.slots[slot] = None
            self.running -= 1

    def take(self, like_id):
        """The download of a like: its files, True when stored, None when not cached or failed (the post page brings
        fresh links). Waits until the downloader got to it."""
        while like_id not in self.passed and self.task and not self.task.done():
            time.sleep(0.1)
        job = self.jobs.pop(like_id, None)
        try:
            return job.result() if job else None
        except Exception as e:  # noqa: BLE001
            print(f"cached download failed: {like_id}: {first_line(e)}", file=sys.stderr)
            return None


def all_likes(page, cache_path):
    """Every like (slim items with the like time), newest first. Scrolling thousands of likes fills the memory, so after
    the first page the Liked tab's own request is repeated page by page with the next cursor: TikTok's script signs page
    fetches. Each page goes to cache_path: a broken listing resumes there."""
    cache = load_state(cache_path) or {"cursor": "0", "more": True, "items": []}
    likes = {i["id"]: i for i in cache["items"]}
    if not cache["more"]:
        return list(likes.values())
    requests = []
    page.on("request", lambda r: "/api/favorite/item_list" in r.url and requests.append(r.url))
    new_likes(page, set(), 1)
    url = urllib.parse.urlsplit(requests[0])
    query = {k: v for k, v in urllib.parse.parse_qsl(url.query) if k not in ("X-Bogus", "X-Gnarly", "_signature", "msToken")}
    cursor = cache["cursor"]
    prev = int(cursor) or None
    while True:
        for attempt in range(5):
            text = page.evaluate("u => fetch(u, {credentials: 'include'}).then(r => r.text())", url._replace(query=urllib.parse.urlencode({**query, "cursor": cursor})).geturl())
            try:
                data = json.loads(text)
                if data.get("statusCode", 0) == 0:
                    break
            except ValueError:
                pass
            handle_captcha(page)
            pause(30 * (attempt + 1))
        else:
            raise RuntimeError(f"the like list stopped loading after {len(likes)} likes; retrying later")
        for item in stamp(data, prev):
            likes.setdefault(item["id"], slim(item))
        more = bool(data.get("hasMore") and data.get("itemList"))
        if more:
            cursor, prev = str(data["cursor"]), int(data["cursor"])
        write_json(cache_path, {"cursor": cursor, "more": more, "items": list(likes.values())})
        if not more:
            return list(likes.values())
        print(f"backfill: {len(likes)} likes listed")
        pause(1.5)


def main():
    load_env()
    sys.stdout.reconfigure(line_buffering=True)  # logs of a service
    if sys.argv[1:] == ["login"]:
        return login()
    path = os.environ.get("STATE_FILE", "state.json")
    interval = int(os.environ.get("INTERVAL", "1800"))
    while True:
        try:
            if os.environ.get("FULL_BACKFILL") == "1" and not (load_state(path) or {}).get("backfill_done"):
                with Tui() as tui:
                    backfill(path, tui)
            else:
                sync(path)
        except Exception as e:  # noqa: BLE001 - a long-running service logs and tries again
            print(f"sync failed: {first_line(e)}", file=sys.stderr)
            if not interval:
                sys.exit(1)
        if not interval:
            return
        time.sleep(interval)


def on_interrupt(signum, frame):
    """The first Ctrl+C stops the run (the state is saved after each like); the next one exits at once."""
    if on_interrupt.pressed:
        os._exit(130)
    on_interrupt.pressed = True
    raise KeyboardInterrupt


on_interrupt.pressed = False

if __name__ == "__main__":
    signal.signal(signal.SIGINT, on_interrupt)
    try:
        main()
    except KeyboardInterrupt:
        print("stopped: the next run goes on from here (Ctrl+C again: exit at once)", file=sys.stderr)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(130)  # no waits for the download threads and the browser
