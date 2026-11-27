#!/usr/bin/env python3
"""Step 4: Export Hot/Cold split deliverables from cold_archive.db.

Generates 4 files in `data_sandbox/out/`:
  1. `hot_library_backup.json` — Restorable `x-toolkit-full` (or legacy `bookmark-keeper`)
     JSON containing ONLY curated hot bookmarks (`tier:S` + `tier:A`, configurable) with
     updated Notion-aligned folders & tags. Typically shrinks ~115MB -> ~10-30MB!
  2. `cleanup_queue_by_account.json` — Per-account X unbookmark queue (`tier:D`) ready for
     v2 extension's safe, rate-limited `DeleteBookmark` queue.
  3. `cleanup_review.md` — Human-readable inspection sheet of everything queued for X removal
     (grouped by reason & sample texts) so you can double-check before unbookmarking on X.
  4. `hot_cold_summary.md` — Exact before/after slimming and domain distribution stats.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Set

from taxonomy import CLEANUP_FOLDER, DOMAIN_NAMES, TIER_A, TIER_B, TIER_D, TIER_S

COLD_FOLDER = "冷库备查"


def fmt_mb(n_bytes: int) -> str:
    return f"{n_bytes / (1024 * 1024):.2f} MB"


def export_outputs(
    db_path: Path,
    out_dir: Path,
    hot_tiers: Set[str],
    keep_timeline_posts: bool = True,
    write_full_classified: bool = True,
) -> Dict[str, Any]:
    if not db_path.exists():
        raise FileNotFoundError(f"Cold archive DB not found: {db_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        envelope_kind = meta.get("envelope_kind", "")
        envelope_json = json.loads(meta["envelope_json"]) if "envelope_json" in meta else None

        existing_folders = {
            r["name"]: {
                "name": r["name"],
                "x_id": r["x_id"],
                "source": r["source"],
                "created_at": r["created_at"],
            }
            for r in conn.execute("SELECT name, x_id, source, created_at FROM folders").fetchall()
        }

        rows = conn.execute(
            """
            SELECT p.tweet_id, p.screen_name, p.text, p.url, p.source, p.status, p.accounts_json,
                   p.raw_bytes, p.raw_json,
                   c.stage, c.domain_folder, c.content_tags_json, c.tier, c.confidence, c.reason
            FROM posts p
            LEFT JOIN classification c ON c.tweet_id = p.tweet_id
            ORDER BY p.sort_index DESC, p.created_at DESC
            """
        ).fetchall()

        now_ms = int(time.time() * 1000)
        hot_posts: List[Dict[str, Any]] = []
        all_classified_posts: List[Dict[str, Any]] = []
        layered_posts: List[Dict[str, Any]] = []
        cold_only_ids: List[str] = []
        cleanup_by_account: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        cleanup_items_all: List[Dict[str, Any]] = []

        total_raw_bytes = 0
        tier_ctr = Counter()
        domain_ctr = Counter()
        hot_domain_ctr = Counter()
        cleanup_reason_ctr = Counter()
        used_folders: Set[str] = set()
        all_used_folders: Set[str] = set()
        layered_used_folders: Set[str] = set()

        for r in rows:
            total_raw_bytes += int(r["raw_bytes"] or 0)
            tier = r["tier"] or TIER_A
            domain = r["domain_folder"] or (CLEANUP_FOLDER if tier == TIER_D else "")
            forms = json.loads(r["content_tags_json"] or "[]")
            reason = r["reason"] or ""
            tier_ctr[tier] += 1
            domain_ctr[domain or "(未归类)"] += 1

            post = json.loads(r["raw_json"])
            is_timeline = (r["source"] or "bookmark") == "timeline"

            # Apply classification folder + tags cleanly (preserving user's existing custom tags)
            if domain and not is_timeline:
                post["folder"] = domain
            existing_tags = [t for t in (post.get("tags") or []) if not str(t).startswith("tier:")]
            merged_tags = list(existing_tags)
            for t in forms + [tier]:
                if t and t not in merged_tags:
                    merged_tags.append(t)
            post["tags"] = merged_tags

            all_classified_posts.append(post)
            if post.get("folder"):
                all_used_folders.add(post["folder"])

            # Layered view: hot items (S/A) stay in 10 core domains, tier:B goes into COLD_FOLDER
            # with its detected domain preserved as a tag (`冷库:<domain>`) for easy mining,
            # and tier:D stays in CLEANUP_FOLDER.
            layered_post = dict(post)
            if tier in hot_tiers or (is_timeline and keep_timeline_posts):
                pass
            elif tier == TIER_D and not is_timeline:
                layered_post["folder"] = CLEANUP_FOLDER
            elif not is_timeline:
                layered_post["folder"] = COLD_FOLDER
                ltags = list(layered_post.get("tags") or [])
                if domain and domain != CLEANUP_FOLDER:
                    cold_tag = f"冷库:{domain}"
                    if cold_tag not in ltags:
                        ltags.append(cold_tag)
                layered_post["tags"] = ltags
            layered_posts.append(layered_post)
            if layered_post.get("folder"):
                layered_used_folders.add(layered_post["folder"])

            if tier in hot_tiers or (is_timeline and keep_timeline_posts):
                hot_posts.append(post)
                hot_domain_ctr[domain or "(未归类)"] += 1
                if post.get("folder"):
                    used_folders.add(post["folder"])
            else:
                cold_only_ids.append(r["tweet_id"])
                if tier == TIER_D and not is_timeline and (r["status"] or "active") == "active":
                    accounts = json.loads(r["accounts_json"] or "[]") or ["__unknown__"]
                    item = {
                        "tweet_id": r["tweet_id"],
                        "url": r["url"],
                        "screen_name": r["screen_name"],
                        "text_preview": (r["text"] or "").replace("\n", " ")[:140],
                        "reason": reason,
                        "accounts": accounts,
                    }
                    cleanup_items_all.append(item)
                    cleanup_reason_ctr[reason.split(";")[0] or "tier:D"] += 1
                    for acc in accounts:
                        cleanup_by_account[acc].append(item)

        def build_folder_list(folder_names: Set[str]) -> List[Dict[str, Any]]:
            out: List[Dict[str, Any]] = []
            for fname in sorted(folder_names):
                if fname in existing_folders:
                    fl = dict(existing_folders[fname])
                    if fl.get("x_id") is None:
                        fl.pop("x_id", None)
                    out.append(fl)
                else:
                    out.append({"name": fname, "source": "local", "created_at": now_ms})
            return out

        def wrap_backup(posts_list: List[Dict[str, Any]], folders_list: List[Dict[str, Any]]) -> Dict[str, Any]:
            if envelope_kind == "x-toolkit-full" and isinstance(envelope_json, dict):
                payload = dict(envelope_json)
                payload["exportedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
                payload["bookmarks"] = {"posts": posts_list, "folders": folders_list}
                return payload
            return {
                "app": "bookmark-keeper",
                "version": 1,
                "exported_at": now_ms,
                "posts": posts_list,
                "folders": folders_list,
            }

        # 1. Write restorable hot_library_backup.json (S+A slimmed hot library)
        hot_folders = build_folder_list(used_folders | set(DOMAIN_NAMES))
        hot_path = out_dir / "hot_library_backup.json"
        hot_payload = wrap_backup(hot_posts, hot_folders)
        hot_str = (
            json.dumps(hot_payload, ensure_ascii=False, indent=2)
            if len(hot_posts) <= 2000
            else json.dumps(hot_payload, ensure_ascii=False, separators=(",", ":"))
        )
        hot_path.write_text(hot_str, encoding="utf-8")
        hot_bytes = hot_path.stat().st_size

        # 1b. Write lossless full_classified_backup.json (ALL posts kept, tier:D placed in 待清理 folder, ZERO deleted!)
        full_bytes = 0
        layered_bytes = 0
        if write_full_classified:
            full_folders = build_folder_list(all_used_folders | set(DOMAIN_NAMES) | {CLEANUP_FOLDER})
            full_path = out_dir / "full_classified_backup.json"
            full_payload = wrap_backup(all_classified_posts, full_folders)
            full_str = (
                json.dumps(full_payload, ensure_ascii=False, indent=2)
                if len(all_classified_posts) <= 2000
                else json.dumps(full_payload, ensure_ascii=False, separators=(",", ":"))
            )
            full_path.write_text(full_str, encoding="utf-8")
            full_bytes = full_path.stat().st_size

            # 1c. Write full_layered_backup.json (ALL posts kept: S+A in 10 core domains, B in 冷库备查, D in 待清理)
            layered_folders = build_folder_list(layered_used_folders | set(DOMAIN_NAMES) | {COLD_FOLDER, CLEANUP_FOLDER})
            layered_path = out_dir / "full_layered_backup.json"
            layered_payload = wrap_backup(layered_posts, layered_folders)
            layered_str = (
                json.dumps(layered_payload, ensure_ascii=False, indent=2)
                if len(layered_posts) <= 2000
                else json.dumps(layered_payload, ensure_ascii=False, separators=(",", ":"))
            )
            layered_path.write_text(layered_str, encoding="utf-8")
            layered_bytes = layered_path.stat().st_size

        # 2. Write cleanup_queue_by_account.json (categorized into 待清理, zero deletion executed)
        cleanup_path = out_dir / "cleanup_queue_by_account.json"
        cleanup_payload = {
            "format": "x-toolkit-cleanup-queue",
            "version": 1,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "note": "Categorized only (待清理). Zero records deleted from SQLite cold archive or X.",
            "total_unique_cleanup_tweets": len(cleanup_items_all),
            "cold_tombstone_ids_count": len(cold_only_ids),
            "accounts": {
                acc: {
                    "count": len(items),
                    "items": items,
                }
                for acc, items in sorted(cleanup_by_account.items(), key=lambda x: len(x[1]), reverse=True)
            },
            "cold_tombstone_ids": cold_only_ids,
        }
        cleanup_path.write_text(json.dumps(cleanup_payload, ensure_ascii=False, indent=2), encoding="utf-8")

        # 3. Write human-readable cleanup_review.md
        review_lines = [
            "# 「待清理」分类清单人工复核单（仅分类标记，零删除）",
            "",
            f"- **生成时间**：{dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"- **归入 `待清理` 类别的条数（active 且标 `tier:D`）**：**{len(cleanup_items_all):,}** 条",
            "- **零删除保障**：以下所有记录均完整保留在 `data_sandbox/cold_archive.db` 与 `full_classified_backup.json` 的 `待清理` 文件夹中，**未执行任何删除**。",
            "",
            "## 按收藏账号分布",
            "",
            "| 账号 | 待清理条数 |",
            "| :--- | ---: |",
        ]
        for acc, items in sorted(cleanup_by_account.items(), key=lambda x: len(x[1]), reverse=True):
            review_lines.append(f"| `{acc}` | {len(items):,} |")

        review_lines.extend(
            [
                "",
                "## 按命中原因分布",
                "",
                "| 原因 | 条数 |",
                "| :--- | ---: |",
            ]
        )
        for reason, cnt in cleanup_reason_ctr.most_common():
            review_lines.append(f"| `{reason}` | {cnt:,} |")

        review_lines.extend(["", "## 抽样预览（前 60 条）", ""])
        for item in cleanup_items_all[:60]:
            review_lines.append(
                f"- `@{item['screen_name']}` ({', '.join(item['accounts'])}) — `{item['reason']}` — "
                f"{item['text_preview']} ([链接]({item['url']}))"
            )
        (out_dir / "cleanup_review.md").write_text("\n".join(review_lines) + "\n", encoding="utf-8")

        # 4. Write hot_cold_summary.md
        shrink_pct = (1.0 - (hot_bytes / max(total_raw_bytes, 1))) * 100
        summary_lines = [
            "# 热冷分层与分类瘦身汇总报告（零删除）",
            "",
            f"- **原始唯一推文总数**：{len(rows):,} 条（原始 JSON 体量约 `{fmt_mb(total_raw_bytes)}`）",
            f"- **精选热库（`hot_library_backup.json`，导入扩展）**：**{len(hot_posts):,}** 条 / **`{fmt_mb(hot_bytes)}`**（体积瘦身 **{shrink_pct:.1f}%**）",
            f"- **全量已分类备份（`full_classified_backup.json`，零删留底）**：{len(all_classified_posts):,} 条 / `{fmt_mb(full_bytes)}`",
            f"- **冷库归档（`tier:B`，留在本地 SQLite 随时秒搜）**：{tier_ctr.get(TIER_B, 0):,} 条",
            f"- **归入 `待清理` 类别（`tier:D`，仅分类不删）**：{len(cleanup_items_all):,} 条",
            "",
            "## 价值层级分布",
            "",
            "| 层级 | 条数 | 占比 |",
            "| :--- | ---: | ---: |",
        ]
        for t in (TIER_S, TIER_A, TIER_B, TIER_D):
            c = tier_ctr.get(t, 0)
            summary_lines.append(f"| `{t}` | {c:,} | {c / max(len(rows), 1) * 100:.1f}% |")

        summary_lines.extend(
            [
                "",
                "## 一级领域分布（全量 62,455 条 vs 精选热库）",
                "",
                "| 领域文件夹 | 全量条数 | 精选热库条数 |",
                "| :--- | ---: | ---: |",
            ]
        )
        for d, c in domain_ctr.most_common():
            summary_lines.append(f"| {d} | {c:,} | {hot_domain_ctr.get(d, 0):,} |")

        (out_dir / "hot_cold_summary.md").write_text("\n".join(summary_lines) + "\n", encoding="utf-8")

        print(
            f"[export] Done -> hot={len(hot_posts):,} ({fmt_mb(hot_bytes)}), "
            f"full_classified={len(all_classified_posts):,} ({fmt_mb(full_bytes)}), "
            f"cold_only={len(cold_only_ids):,}, cleanup_bucket={len(cleanup_items_all):,}"
        )
        return {
            "total": len(rows),
            "hot_count": len(hot_posts),
            "hot_bytes": hot_bytes,
            "full_bytes": full_bytes,
            "cold_only_count": len(cold_only_ids),
            "cleanup_count": len(cleanup_items_all),
            "out_dir": str(out_dir),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Hot Library JSON + Per-Account X Cleanup Queue.")
    parser.add_argument("--db", type=Path, default=Path("data_sandbox/cold_archive.db"))
    parser.add_argument("--out-dir", type=Path, default=Path("data_sandbox/out"))
    parser.add_argument(
        "--include-b-tier",
        action="store_true",
        help="Also include tier:B posts in hot library (default: only tier:S and tier:A)",
    )
    args = parser.parse_args()
    tiers = {TIER_S, TIER_A}
    if args.include_b_tier:
        tiers.add(TIER_B)
    export_outputs(args.db, args.out_dir, hot_tiers=tiers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
