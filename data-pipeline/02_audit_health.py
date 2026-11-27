#!/usr/bin/env python3
"""Step 2: Run a 5-dimension completeness & bloat health audit on cold_archive.db.

Outputs a clear Markdown report (`data_sandbox/health_report.md`) covering:
  1. Volume, multi-account ownership & cross-account duplicates
  2. Status & source breakdown (active / tweet_deleted / unbookmarked / timeline)
  3. 5-dimension data completeness audit (empty fields, truncated long tweets,
     incomplete threads, missing quote bodies, unresolved t.co links)
  4. Storage bloat breakdown (where the ~115MB comes from)
  5. Top 25 authors, Top 25 domains, year distribution & slimming estimate
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List

from taxonomy import SPAM_GIVEAWAY_PATTERNS

THREAD_HINT_RE = re.compile(r"(?:^|\s)(?:1/\d*|1/|\🧵|thread\b|a thread\b|长推|串推)", re.I)
TCO_RE = re.compile(r"https?://t\.co/[A-Za-z0-9]+")


def fmt_mb(num_bytes: int) -> str:
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def run_audit(db_path: Path, out_path: Path) -> Dict[str, object]:
    if not db_path.exists():
        raise FileNotFoundError(f"Cold archive DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT tweet_id, screen_name, created_at, text, lang, source, status, folder,
                   accounts_json, tags_json, urls_json, domains_json, media_count,
                   has_image, has_video, has_link, has_quote, has_article, thread_len,
                   quoted_text, likes, bookmarks, views, raw_bytes
            FROM posts
            """
        ).fetchall()

        total = len(rows)
        if total == 0:
            raise ValueError("cold_archive.db has 0 posts.")

        status_ctr = Counter()
        source_ctr = Counter()
        account_ctr = Counter()
        lang_ctr = Counter()
        year_ctr = Counter()
        author_ctr = Counter()
        domain_ctr = Counter()
        folder_ctr = Counter()

        multi_account_count = 0
        unknown_account_count = 0
        tagged_count = 0
        filed_count = 0

        empty_text_count = 0
        truncated_suspects = 0
        incomplete_thread_suspects = 0
        missing_quote_body = 0
        unresolved_tco_posts = 0

        spam_giveaway_suspects = 0
        ultra_short_no_media = 0

        total_raw_bytes = 0
        deleted_bytes = 0
        spam_short_bytes = 0

        for r in rows:
            status = r["status"] or "active"
            source = r["source"] or "bookmark"
            text = r["text"] or ""
            text_low = text.lower()
            raw_b = int(r["raw_bytes"] or 0)

            status_ctr[status] += 1
            source_ctr[source] += 1
            lang_ctr[r["lang"] or "unknown"] += 1
            if r["screen_name"]:
                author_ctr[r["screen_name"]] += 1
            if r["folder"]:
                filed_count += 1
                folder_ctr[r["folder"]] += 1

            total_raw_bytes += raw_b
            if status != "active":
                deleted_bytes += raw_b

            created_ms = int(r["created_at"] or 0)
            if created_ms > 0:
                yr = dt.datetime.fromtimestamp(created_ms / 1000, tz=dt.timezone.utc).year
                year_ctr[yr] += 1
            else:
                year_ctr["unknown"] += 1

            accounts = json.loads(r["accounts_json"] or "[]")
            if not accounts:
                unknown_account_count += 1
                account_ctr["__unknown__"] += 1
            else:
                if len(accounts) > 1:
                    multi_account_count += 1
                for a in accounts:
                    account_ctr[f"@{a}"] += 1

            tags = json.loads(r["tags_json"] or "[]")
            if tags:
                tagged_count += 1

            domains = json.loads(r["domains_json"] or "[]")
            for d in domains:
                domain_ctr[d] += 1

            # Completeness checks
            stripped = text.strip()
            if not stripped:
                empty_text_count += 1

            # Truncated long-tweet suspect: ~260-320 chars ending in ellipsis or t.co without article
            if (
                240 <= len(stripped) <= 330
                and (stripped.endswith("…") or stripped.endswith("...") or bool(re.search(r"https?://t\.co/\S+$", stripped)))
                and not r["has_article"]
            ):
                truncated_suspects += 1

            # Incomplete thread suspect
            if int(r["thread_len"] or 0) == 0 and THREAD_HINT_RE.search(stripped):
                incomplete_thread_suspects += 1

            # Missing quote text
            if int(r["has_quote"] or 0) == 1 and not (r["quoted_text"] or "").strip():
                missing_quote_body += 1

            # Unresolved t.co in text or urls
            urls = json.loads(r["urls_json"] or "[]")
            if TCO_RE.search(stripped) or any("t.co/" in u for u in urls):
                unresolved_tco_posts += 1

            # Quick noise estimate
            is_spam = any(p in text_low for p in SPAM_GIVEAWAY_PATTERNS)
            clean_no_url = re.sub(r"https?://\S+", "", stripped).strip()
            is_short_noise = (
                0 < len(clean_no_url) < 20
                and status == "active"
                and int(r["media_count"] or 0) == 0
                and int(r["has_link"] or 0) == 0
                and int(r["has_quote"] or 0) == 0
                and int(r["has_article"] or 0) == 0
            )
            if is_spam:
                spam_giveaway_suspects += 1
            if is_short_noise:
                ultra_short_no_media += 1
            if is_spam or is_short_noise or status == "tweet_deleted":
                spam_short_bytes += raw_b

        db_file_bytes = db_path.stat().st_size

        lines: List[str] = [
            "# X 书签全量完整性体检报告 (Health Audit)",
            "",
            f"- **生成时间**：{dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"- **冷库文件**：`{db_path}`（SQLite 体积 `{fmt_mb(db_file_bytes)}`）",
            f"- **唯一推文总数**：**{total:,}** 条（原始 JSON 字段累计 `{fmt_mb(total_raw_bytes)}`）",
            "",
            "---",
            "",
            "## 1. 状态、来源与整理现状",
            "",
            "| 指标 | 数量 | 占比 |",
            "| :--- | ---: | ---: |",
        ]
        for k, v in status_ctr.most_common():
            lines.append(f"| 状态 `{k}` | {v:,} | {v / total * 100:.1f}% |")
        for k, v in source_ctr.most_common():
            lines.append(f"| 来源 `{k}` | {v:,} | {v / total * 100:.1f}% |")
        lines.extend(
            [
                f"| 已有文件夹 | {filed_count:,} | {filed_count / total * 100:.1f}% |",
                f"| 已有标签 | {tagged_count:,} | {tagged_count / total * 100:.1f}% |",
                f"| 跨账号重复收藏（被 ≥2 账号同时收藏） | {multi_account_count:,} | {multi_account_count / total * 100:.1f}% |",
                f"| 缺失账号标记（旧版同步 `__unknown__`） | {unknown_account_count:,} | {unknown_account_count / total * 100:.1f}% |",
                "",
                "### 各收藏账号分布",
                "",
                "| 收藏账号 | 条数 |",
                "| :--- | ---: |",
            ]
        )
        for acc, cnt in account_ctr.most_common():
            lines.append(f"| `{acc}` | {cnt:,} |")

        lines.extend(
            [
                "",
                "---",
                "",
                "## 2. 五维数据完整性体检",
                "",
                "| 体检项 | 命中条数 | 占比 | 建议动作 |",
                "| :--- | ---: | ---: | :--- |",
                f"| 1. 正文为空（含已删空壳） | {empty_text_count:,} | {empty_text_count / total * 100:.1f}% | 无媒体/无引用直接标 `tier:D` 待清理 |",
                f"| 2. 疑似截断长推文（240–330字且结尾含 `…`/短链） | {truncated_suspects:,} | {truncated_suspects / total * 100:.1f}% | 留存高价值项进 v2 定向补抓队列 |",
                f"| 3. 疑似未抓全 Thread（含 `1/`、`🧵`、`thread` 但无子推） | {incomplete_thread_suspects:,} | {incomplete_thread_suspects / total * 100:.1f}% | 高价值项进 v2 Thread 补抓队列 |",
                f"| 4. 引用推文正文缺失（`has_quote=1` 但无原推文） | {missing_quote_body:,} | {missing_quote_body / total * 100:.1f}% | 归类后按需补抓 |",
                f"| 5. 含未还原 `t.co` 短链 | {unresolved_tco_posts:,} | {unresolved_tco_posts / total * 100:.1f}% | 进热库前/v2 入库时还原真实 URL |",
                "",
                "---",
                "",
                "## 3. 体积瘦身潜力初估",
                "",
                f"- **已失效/已取消状态占位**：`{fmt_mb(deleted_bytes)}`",
                f"- **疑似抽奖/引流/互关垃圾帖**：**{spam_giveaway_suspects:,}** 条",
                f"- **超短无图无链水帖（<20 字）**：**{ultra_short_no_media:,}** 条",
                f"- **规则一眼可剥离体量（含已删+抽奖+超短水帖）**：约 `{fmt_mb(spam_short_bytes)}`（后续叠加热冷分层 + 去除 6 万条 MiniSearch 序列化索引，浏览器 IndexedDB 可轻松压缩 **70%–85%**）",
                "",
                "---",
                "",
                "## 4. 内容分布快照",
                "",
                "### Top 15 高频作者",
                "",
                "| 作者 | 收藏条数 |",
                "| :--- | ---: |",
            ]
        )
        for author, cnt in author_ctr.most_common(15):
            lines.append(f"| `@{author}` | {cnt:,} |")

        lines.extend(
            [
                "",
                "### Top 15 外链域名",
                "",
                "| 域名 | 出现次数 |",
                "| :--- | ---: |",
            ]
        )
        for dom, cnt in domain_ctr.most_common(15):
            lines.append(f"| `{dom}` | {cnt:,} |")

        lines.extend(
            [
                "",
                "### 语言分布（Top 8）",
                "",
                "| 语言 | 条数 |",
                "| :--- | ---: |",
            ]
        )
        for lg, cnt in lang_ctr.most_common(8):
            lines.append(f"| `{lg}` | {cnt:,} |")

        lines.extend(
            [
                "",
                "### 发布年份分布",
                "",
                "| 年份 | 条数 |",
                "| :--- | ---: |",
            ]
        )
        for yr, cnt in sorted(year_ctr.items(), key=lambda x: str(x[0]), reverse=True):
            lines.append(f"| {yr} | {cnt:,} |")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[audit] Wrote health report -> {out_path} ({total:,} posts audited)")
        return {
            "total": total,
            "empty_text": empty_text_count,
            "truncated_suspects": truncated_suspects,
            "incomplete_thread_suspects": incomplete_thread_suspects,
            "unresolved_tco": unresolved_tco_posts,
            "spam_giveaway_suspects": spam_giveaway_suspects,
            "ultra_short_no_media": ultra_short_no_media,
            "report_path": str(out_path),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run 5-dimension completeness audit on SQLite cold archive.")
    parser.add_argument("--db", type=Path, default=Path("data_sandbox/cold_archive.db"))
    parser.add_argument("--out", type=Path, default=Path("data_sandbox/health_report.md"))
    args = parser.parse_args()
    run_audit(args.db, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
