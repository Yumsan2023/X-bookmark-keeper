#!/usr/bin/env python3
"""Step 1: Import exported Chrome extension bookmark JSON(s) into local SQLite cold archive.

Supports all 4 X Bookmark Keeper / X Toolkit JSON formats automatically:
  1. x-toolkit-full (Settings -> 一键全量备份)
  2. bookmark-keeper-account (Settings -> 按账号导出)
  3. bookmark-keeper legacy v1 ({ app: 'bookmark-keeper', posts: [...], folders: [...] })
  4. Plain Post[] array (Library -> Export JSON)

All raw post JSON is stored losslessly in `cold_archive.db` alongside an FTS5 full-text
search index so the cold archive stays permanently searchable even after trimming Chrome.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse


SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    name TEXT PRIMARY KEY,
    x_id TEXT,
    source TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
    tweet_id TEXT PRIMARY KEY,
    sort_index TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    screen_name TEXT DEFAULT '',
    name TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_at INTEGER DEFAULT 0,
    saved_at INTEGER DEFAULT 0,
    text TEXT DEFAULT '',
    lang TEXT DEFAULT '',
    url TEXT DEFAULT '',
    source TEXT DEFAULT 'bookmark',
    status TEXT DEFAULT 'active',
    folder TEXT DEFAULT '',
    note TEXT DEFAULT '',
    accounts_json TEXT DEFAULT '[]',
    tags_json TEXT DEFAULT '[]',
    urls_json TEXT DEFAULT '[]',
    domains_json TEXT DEFAULT '[]',
    media_count INTEGER DEFAULT 0,
    has_image INTEGER DEFAULT 0,
    has_video INTEGER DEFAULT 0,
    has_link INTEGER DEFAULT 0,
    has_quote INTEGER DEFAULT 0,
    has_article INTEGER DEFAULT 0,
    thread_len INTEGER DEFAULT 0,
    quoted_screen_name TEXT DEFAULT '',
    quoted_text TEXT DEFAULT '',
    quoted_article_title TEXT DEFAULT '',
    likes INTEGER DEFAULT 0,
    retweets INTEGER DEFAULT 0,
    replies INTEGER DEFAULT 0,
    quotes INTEGER DEFAULT 0,
    bookmarks INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    raw_bytes INTEGER DEFAULT 0,
    raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_screen_name ON posts(screen_name);
CREATE INDEX IF NOT EXISTS idx_posts_status_source ON posts(status, source);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_likes ON posts(likes);
CREATE INDEX IF NOT EXISTS idx_posts_folder ON posts(folder);

CREATE TABLE IF NOT EXISTS post_embeddings (
    tweet_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS classification (
    tweet_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,           -- 'rules' | 'embed' | 'llm' | 'manual'
    domain_folder TEXT NOT NULL,   -- One of 10 Notion domains or ''
    content_tags_json TEXT NOT NULL DEFAULT '[]',
    tier TEXT NOT NULL,            -- tier:S / A / B / D
    confidence REAL NOT NULL DEFAULT 0.0,
    reason TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cls_tier ON classification(tier);
CREATE INDEX IF NOT EXISTS idx_cls_domain ON classification(domain_folder);
CREATE INDEX IF NOT EXISTS idx_cls_stage ON classification(stage);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    tweet_id UNINDEXED,
    screen_name,
    name,
    text,
    quoted_text,
    quoted_article_title,
    note
);
"""


def extract_domains(urls: Iterable[str]) -> List[str]:
    seen = []
    seen_set = set()
    for u in urls or []:
        if not isinstance(u, str) or not u.strip():
            continue
        try:
            host = urlparse(u).netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            if host and host not in seen_set:
                seen_set.add(host)
                seen.append(host)
        except Exception:
            continue
    return seen


def detect_and_extract(raw: Any) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Return (kind, posts, folders, envelope_without_posts)."""
    if isinstance(raw, list):
        return "plain-array", [p for p in raw if isinstance(p, dict) and p.get("tweet_id")], [], None

    if not isinstance(raw, dict):
        raise ValueError("Unsupported JSON root type (expected object or array).")

    fmt = raw.get("format")
    if fmt == "x-toolkit-full" and isinstance(raw.get("bookmarks"), dict):
        bm = raw["bookmarks"]
        posts = bm.get("posts") or []
        folders = bm.get("folders") or []
        envelope = {k: v for k, v in raw.items() if k != "bookmarks"}
        return "x-toolkit-full", posts, folders, envelope

    if fmt == "bookmark-keeper-account" and isinstance(raw.get("posts"), list):
        posts = raw.get("posts") or []
        folders = raw.get("folders") or []
        envelope = {k: v for k, v in raw.items() if k not in ("posts", "folders")}
        return "bookmark-keeper-account", posts, folders, envelope

    if raw.get("app") == "bookmark-keeper" and isinstance(raw.get("posts"), list):
        posts = raw.get("posts") or []
        folders = raw.get("folders") or []
        envelope = {k: v for k, v in raw.items() if k not in ("posts", "folders")}
        return "bookmark-keeper-legacy", posts, folders, envelope

    if isinstance(raw.get("posts"), list):
        posts = raw.get("posts") or []
        folders = raw.get("folders") or []
        return "generic-posts", posts, folders, None

    raise ValueError("Unrecognized JSON structure. Expected x-toolkit-full, bookmark-keeper, or Post[].")


def merge_post_dicts(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    """Losslessly merge duplicate tweet_id records across multiple account exports."""
    merged = dict(existing)

    # Prefer richer text / non-deleted status
    if incoming.get("status") == "active" and existing.get("status") != "active":
        merged["status"] = "active"
    if len(str(incoming.get("text") or "")) > len(str(existing.get("text") or "")):
        merged["text"] = incoming["text"]

    # Prefer richer thread / quoted / media
    if len(incoming.get("thread") or []) > len(existing.get("thread") or []):
        merged["thread"] = incoming["thread"]
        merged["thread_fetched_at"] = incoming.get("thread_fetched_at")
    if incoming.get("quoted") and not existing.get("quoted"):
        merged["quoted"] = incoming["quoted"]
    if len(incoming.get("media") or []) > len(existing.get("media") or []):
        merged["media"] = incoming["media"]

    # Union accounts and tags
    acc_set = []
    for src in (existing.get("accounts"), incoming.get("accounts")):
        for a in src or []:
            a_norm = str(a).strip().lstrip("@").lower()
            if a_norm and a_norm not in acc_set:
                acc_set.append(a_norm)
    merged["accounts"] = acc_set

    tag_set = []
    for src in (existing.get("tags"), incoming.get("tags")):
        for t in src or []:
            t_str = str(t).strip()
            if t_str and t_str not in tag_set:
                tag_set.append(t_str)
    merged["tags"] = tag_set

    # Keep folder / note if existing is blank
    if not merged.get("folder") and incoming.get("folder"):
        merged["folder"] = incoming["folder"]
    if not merged.get("note") and incoming.get("note"):
        merged["note"] = incoming["note"]

    # Keep max metrics
    m_old = existing.get("metrics") or {}
    m_new = incoming.get("metrics") or {}
    merged["metrics"] = {
        k: max(int(m_old.get(k) or 0), int(m_new.get(k) or 0))
        for k in ("replies", "retweets", "likes", "quotes", "bookmarks", "views")
    }
    return merged


def post_to_row(p: Dict[str, Any]) -> Tuple[Any, ...]:
    metrics = p.get("metrics") or {}
    quoted = p.get("quoted") or {}
    urls = [u for u in (p.get("urls") or []) if isinstance(u, str)]
    domains = extract_domains(urls)
    accounts = [
        str(a).strip().lstrip("@").lower()
        for a in (p.get("accounts") or [])
        if str(a).strip()
    ]
    tags = [str(t).strip() for t in (p.get("tags") or []) if str(t).strip()]
    media = p.get("media") or []
    thread = p.get("thread") or []
    raw_str = json.dumps(p, ensure_ascii=False, separators=(",", ":"))
    return (
        str(p["tweet_id"]),
        str(p.get("sort_index") or ""),
        str(p.get("user_id") or ""),
        str(p.get("screen_name") or "").lstrip("@").lower(),
        str(p.get("name") or ""),
        str(p.get("avatar") or ""),
        int(p.get("created_at") or 0),
        int(p.get("saved_at") or 0),
        str(p.get("text") or ""),
        str(p.get("lang") or ""),
        str(p.get("url") or f"https://x.com/{p.get('screen_name', 'i')}/status/{p['tweet_id']}"),
        str(p.get("source") or "bookmark"),
        str(p.get("status") or "active"),
        str(p.get("folder") or ""),
        str(p.get("note") or ""),
        json.dumps(accounts, ensure_ascii=False),
        json.dumps(tags, ensure_ascii=False),
        json.dumps(urls, ensure_ascii=False),
        json.dumps(domains, ensure_ascii=False),
        len(media),
        1 if p.get("has_image") else 0,
        1 if p.get("has_video") else 0,
        1 if p.get("has_link") else 0,
        1 if p.get("has_quote") else 0,
        1 if p.get("has_article") else 0,
        len(thread),
        str(quoted.get("screen_name") or "").lstrip("@").lower() if isinstance(quoted, dict) else "",
        str(quoted.get("text") or "") if isinstance(quoted, dict) else "",
        str(quoted.get("article_title") or "") if isinstance(quoted, dict) else "",
        int(metrics.get("likes") or 0),
        int(metrics.get("retweets") or 0),
        int(metrics.get("replies") or 0),
        int(metrics.get("quotes") or 0),
        int(metrics.get("bookmarks") or 0),
        int(metrics.get("views") or 0),
        len(raw_str.encode("utf-8")),
        raw_str,
    )


def import_files(input_paths: List[Path], db_path: Path, inspect_only: bool = False) -> Dict[str, Any]:
    t0 = time.time()
    posts_by_id: Dict[str, Dict[str, Any]] = {}
    folders_by_name: Dict[str, Dict[str, Any]] = {}
    source_kinds: List[str] = []
    saved_envelope: Optional[Tuple[str, Dict[str, Any]]] = None
    raw_total = 0
    duplicate_merges = 0

    for path in input_paths:
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")
        size_mb = path.stat().st_size / (1024 * 1024)
        print(f"[import] Reading {path.name} ({size_mb:.2f} MB)...", flush=True)
        with path.open("r", encoding="utf-8") as f:
            raw = json.load(f)

        kind, posts, folders, envelope = detect_and_extract(raw)
        source_kinds.append(f"{path.name}:{kind}({len(posts)})")
        if envelope is not None and (saved_envelope is None or kind == "x-toolkit-full"):
            saved_envelope = (kind, envelope)

        if inspect_only:
            sample = posts[:3]
            print(f"[inspect] Format={kind} | posts={len(posts)} | folders={len(folders)}")
            if sample:
                print(f"[inspect] Sample keys: {sorted(sample[0].keys())}")
                print(f"[inspect] First post tweet_id={sample[0].get('tweet_id')} author=@{sample[0].get('screen_name')} accounts={sample[0].get('accounts')}")
            continue

        for fl in folders:
            name = str(fl.get("name") or "").strip()
            if name and name not in folders_by_name:
                folders_by_name[name] = {
                    "name": name,
                    "x_id": fl.get("x_id"),
                    "source": fl.get("source") or "local",
                    "created_at": int(fl.get("created_at") or 0),
                }

        for p in posts:
            if not isinstance(p, dict) or not p.get("tweet_id"):
                continue
            raw_total += 1
            tid = str(p["tweet_id"])
            if tid in posts_by_id:
                posts_by_id[tid] = merge_post_dicts(posts_by_id[tid], p)
                duplicate_merges += 1
            else:
                posts_by_id[tid] = p

    if inspect_only:
        return {"inspect_only": True, "sources": source_kinds}

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(SCHEMA_SQL)

        # Preserve any existing posts in DB if merging incrementally
        existing_rows = conn.execute("SELECT tweet_id, raw_json FROM posts").fetchall()
        for tid, rjson in existing_rows:
            if tid in posts_by_id:
                posts_by_id[tid] = merge_post_dicts(json.loads(rjson), posts_by_id[tid])
                duplicate_merges += 1

        with conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO folders (name, x_id, source, created_at)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (f["name"], f.get("x_id"), f.get("source", "local"), int(f.get("created_at") or 0))
                    for f in folders_by_name.values()
                ],
            )

            rows = [post_to_row(p) for p in posts_by_id.values()]
            conn.executemany(
                """
                INSERT OR REPLACE INTO posts (
                    tweet_id, sort_index, user_id, screen_name, name, avatar,
                    created_at, saved_at, text, lang, url, source, status, folder, note,
                    accounts_json, tags_json, urls_json, domains_json, media_count,
                    has_image, has_video, has_link, has_quote, has_article, thread_len,
                    quoted_screen_name, quoted_text, quoted_article_title,
                    likes, retweets, replies, quotes, bookmarks, views, raw_bytes, raw_json
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                rows,
            )

            # Rebuild FTS5 cleanly
            conn.execute("DELETE FROM posts_fts")
            conn.execute(
                """
                INSERT INTO posts_fts (tweet_id, screen_name, name, text, quoted_text, quoted_article_title, note)
                SELECT tweet_id, screen_name, name, text, quoted_text, quoted_article_title, note FROM posts
                """
            )

            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                ("imported_at", str(int(time.time()))),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                ("import_sources", json.dumps(source_kinds, ensure_ascii=False)),
            )
            if saved_envelope is not None:
                env_kind, env_obj = saved_envelope
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    ("envelope_kind", env_kind),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    ("envelope_json", json.dumps(env_obj, ensure_ascii=False)),
                )

        total_in_db = conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
        elapsed = time.time() - t0
        print(
            f"[done] Imported {raw_total} raw records ({duplicate_merges} merged duplicates) -> "
            f"{total_in_db} unique posts in {db_path} ({elapsed:.2f}s)"
        )
        return {
            "raw_total": raw_total,
            "duplicate_merges": duplicate_merges,
            "unique_total": total_in_db,
            "folders": len(folders_by_name),
            "db_path": str(db_path),
            "elapsed_sec": round(elapsed, 2),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Import X Bookmark Keeper JSON backup(s) into SQLite cold archive.")
    parser.add_argument("inputs", nargs="+", type=Path, help="One or more exported JSON files in data_sandbox/")
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("data_sandbox/cold_archive.db"),
        help="Target SQLite cold archive path (default: data_sandbox/cold_archive.db)",
    )
    parser.add_argument("--inspect", action="store_true", help="Only inspect format and first 3 rows without writing DB")
    args = parser.parse_args()
    import_files(args.inputs, args.db, inspect_only=args.inspect)
    return 0


if __name__ == "__main__":
    sys.exit(main())
