#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "qrcode"]
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
  CHROMIUM         optional: path of a Chromium/Chrome binary instead of the playwright one
  NOCAPTCHAAI_KEY  optional: nocaptchaai.com key, solves the rotate captcha (else it is closed)
  HEADLESS         0 runs a normal browser window, default 1. TikTok rejects even right captcha answers from
                   headless Chromium and shows it captchas more often: on a server use HEADLESS=0 xvfb-run -a ./sync.py

Usage:
  uvx playwright install chromium   once, or set CHROMIUM
  ./sync.py login   log in: scan the QR code in the TikTok app (Profile → ☰ → scanner) and confirm
  ./sync.py         sync (or uv run sync.py)
"""

import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
CLIENT_UA = "memesave-tiktok-sync/1.0"  # Cloudflare blocks the urllib default (error 1010)
SEEN_MAX = 5000  # likes are newest first: the first seen one ends a sync
LOGIN_WAIT = 300  # seconds
IDLE_SCROLLS = 6  # scrolls without new likes before the list counts as loaded
NOCAPTCHA = "https://api.nocaptchaai.com"
CAPTCHA_TRIES = 3
PHOTO_MAX, VIDEO_MAX, THUMB_MAX = 10 << 20, 50 << 20, (1 << 20) - 1  # memesave upload limits


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


def browser(p):
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
            print(f"captcha not solved: {e}", file=sys.stderr)
            break
        page.wait_for_timeout(3000)  # a wrong answer brings a new captcha
    close = page.locator("#captcha_close_button")
    if close.count():
        close.click()
        page.wait_for_timeout(1500)


def new_likes(page, seen, limit):
    """Likes after the newest seen one, newest first, at most `limit`: scrolls the Liked tab and reads its API answers."""
    items, state = {}, {"more": True}  # dict: answers may repeat, insertion keeps the order

    def on_response(res):
        if "/api/favorite/item_list" not in res.url:
            return
        try:
            data = res.json()
        except Exception:  # noqa: BLE001 - an empty anti-bot answer
            return
        for item in data.get("itemList") or []:
            items.setdefault(item["id"], item)
        state["more"] = bool(data.get("hasMore"))

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
    while state["more"] and idle < IDLE_SCROLLS and len(items) < limit and not seen.intersection(items):
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
    return found[:limit]


def fetch(page, urls, mime, limit):
    """Bytes and type of a TikTok CDN file, with the session's cookies (the CDN needs them); tries each mirror URL."""
    error = "no URL"
    for url in filter(None, urls):
        res = page.request.get(url, headers={"Referer": "https://www.tiktok.com/"}, timeout=120_000)
        if not res.ok:
            error = f"HTTP {res.status} {url[:80]}"
            continue
        body = res.body()
        if len(body) > limit:
            raise RuntimeError(f"too large: {len(body)} bytes")
        got = res.headers.get("content-type", "").split(";")[0]
        return body, got if got.startswith(mime.split("/")[0] + "/") else mime
    raise RuntimeError(error)


def like_files(page, item):
    """Upload fields of a liked post: every photo of a carousel, or the video with its cover (as cobalt does)."""
    images = (item.get("imagePost") or {}).get("images")
    if images:
        files = []
        for img in images:
            urls = sorted(img["imageURL"]["urlList"], key=lambda u: ".jpeg?" not in u)  # JPEG first
            files.append({"file": fetch(page, urls, "image/jpeg", PHOTO_MAX), "width": img.get("imageWidth"), "height": img.get("imageHeight")})
        return files
    v = item["video"]
    try:  # the preview of the video in memesave; originCover is a small JPEG, cover may be a big PNG
        cover = fetch(page, [v.get("originCover"), v.get("cover")], "image/jpeg", THUMB_MAX)
    except Exception:  # noqa: BLE001
        cover = None
    file = fetch(page, [v.get("playAddr"), v.get("downloadAddr")], "video/mp4", VIDEO_MAX)
    return [{"file": file, "thumb": cover, "width": v.get("width"), "height": v.get("height"), "duration": v.get("duration")}]


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


def save_like(page, item):
    """Uploads the files of a like (a carousel as one album); falls back to the link import through cobalt."""
    url = f"https://www.tiktok.com/@{item['author']['uniqueId']}/video/{item['id']}"
    try:
        files = like_files(page, item)
    except Exception as e:  # noqa: BLE001 - cobalt may still get it
        print(f"download failed, importing the link: {url}: {e}", file=sys.stderr)
        return api("/app/api/import", json.dumps({"url": url}).encode(), "application/json")
    album = f"tiktok:{item['id']}" if len(files) > 1 else None
    return all(upload({**f, "source": url, "album": album, "position": i}) for i, f in enumerate(files))


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def save_state(path, seen):
    with open(path + ".tmp", "w") as f:
        json.dump({"seen": seen[-SEEN_MAX:]}, f)
    os.replace(path + ".tmp", path)


def sync():
    path = os.environ.get("STATE_FILE", "state.json")
    state = load_state(path)
    seen = state["seen"] if state else []
    with sync_playwright() as p:
        ctx = browser(p)
        try:
            if not logged_in(ctx):
                sys.exit("not logged in: run ./sync.py login")
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            # The first run imports the newest BACKFILL likes (at least one is read: it marks where the next sync stops).
            likes = new_likes(page, set(seen), SEEN_MAX if state else max(1, int(os.environ.get("BACKFILL", "50"))))
            imports = len(likes) if state else int(os.environ.get("BACKFILL", "50"))
            # Oldest first, so the library keeps the like order.
            for i, item in reversed(list(enumerate(likes))):
                if i < imports and not save_like(page, item):
                    break  # newer likes stay unseen: the next sync retries from this one
                seen.append(item["id"])
                save_state(path, seen)
        finally:
            ctx.close()
    print(f"synced: {min(len(likes), imports)} new likes")


def main():
    load_env()
    sys.stdout.reconfigure(line_buffering=True)  # logs of a service
    if sys.argv[1:] == ["login"]:
        return login()
    interval = int(os.environ.get("INTERVAL", "1800"))
    while True:
        try:
            sync()
        except Exception as e:  # noqa: BLE001 - a long-running service logs and tries again
            print(f"sync failed: {e}", file=sys.stderr)
            if not interval:
                sys.exit(1)
        if not interval:
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
