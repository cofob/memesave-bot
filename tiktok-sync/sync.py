#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Imports liked TikToks into memesave over its API (stdlib only).

The likes come from TikTok's internal web API (reverse engineered, can break at any time) with the cookies
of a logged-in browser session. Every new like goes to POST /app/api/import, which downloads it through cobalt.

Environment:
  MEMESAVE_URL     e.g. https://memereserve.cfb.wtf
  MEMESAVE_TOKEN   API token with write access (Account → Settings → API tokens)
  TIKTOK_COOKIES   Cookie header of tiktok.com from the browser (needs sessionid)
  TIKTOK_SECUID    optional: secUid of the account
  STATE_FILE       default: state.json (ids of imported likes)
  INTERVAL         seconds between syncs, default 1800; 0 = run once
  BACKFILL         likes to import on the first run, default 50 (older ones are only marked as seen)

Usage: ./sync.py (or uv run sync.py, python3 sync.py)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
PAGE = 30
SEEN_MAX = 5000  # likes are newest first: the first seen one ends a sync


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        sys.exit(f"{name} is not set")
    return value


def get_json(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as res:
        return json.load(res)


def likes_page(cursor):
    """One page of liked items (newest first), the next cursor and whether there are more."""
    params = {
        "aid": "1988",
        "app_name": "tiktok_web",
        "device_platform": "web_pc",
        "cookie_enabled": "true",
        "count": str(PAGE),
        "cursor": str(cursor),
        "from_page": "user",
        "user_is_login": "true",
    }
    if os.environ.get("TIKTOK_SECUID"):
        params["secUid"] = os.environ["TIKTOK_SECUID"]
    url = "https://www.tiktok.com/api/favorite/item_list/?" + urllib.parse.urlencode(params)
    data = get_json(url, {"User-Agent": UA, "Accept": "application/json", "Referer": "https://www.tiktok.com/", "Cookie": env("TIKTOK_COOKIES")})
    if "itemList" not in data and data.get("statusCode", 0) != 0:
        raise RuntimeError(f"tiktok: {data.get('statusCode')} {data.get('status_msg', '')}")
    return data.get("itemList") or [], data.get("cursor", 0), bool(data.get("hasMore"))


def new_likes(seen, limit):
    """Likes after the newest seen one, newest first, at most `limit`."""
    found, cursor = [], 0
    while len(found) < limit:
        items, cursor, more = likes_page(cursor)
        for item in items:
            if item["id"] in seen:
                return found
            found.append(item)
        if not more or not items:
            break
    return found[:limit]


def import_link(url):
    """True when memesave queued the link; raises on errors that stop the sync (auth, payment)."""
    req = urllib.request.Request(
        env("MEMESAVE_URL").rstrip("/") + "/app/api/import",
        data=json.dumps({"url": url}).encode(),
        headers={"Authorization": f"Bearer {env('MEMESAVE_TOKEN')}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True
    except urllib.error.HTTPError as e:
        if e.code in (401, 402, 403):
            raise RuntimeError(f"memesave: HTTP {e.code} {e.read().decode(errors='replace')}")
        print(f"import failed: {url}: HTTP {e.code}", file=sys.stderr)
        return False


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
    first = state is None
    seen = state["seen"] if state else []
    likes = new_likes(set(seen), 100_000 if first else SEEN_MAX)
    backfill = int(os.environ.get("BACKFILL", "50")) if first else len(likes)
    # Oldest first, so the library keeps the like order; skipped old likes are only marked as seen.
    for i, item in reversed(list(enumerate(likes))):
        url = f"https://www.tiktok.com/@{item['author']['uniqueId']}/video/{item['id']}"
        if i < backfill and not import_link(url):
            break  # newer likes stay unseen: the next sync retries from this one
        seen.append(item["id"])
        save_state(path, seen)
    if first:
        save_state(path, seen)
    print(f"synced: {min(len(likes), backfill)} new likes")


def main():
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
