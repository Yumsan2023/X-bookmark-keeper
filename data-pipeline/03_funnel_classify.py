#!/usr/bin/env python3
"""Step 3: 3-Stage Local Funnel Classifier (Zero cloud upload, 100% local on M5 Pro).

Stage 1 (`--stage rules`):
  Deterministic Python rules: flags obvious noise/giveaways/deleted shells as `tier:D`,
  maps clear external domains & strong keywords into the 10 Notion domains + content-form tags.

Stage 2 (`--stage embed`):
  Calls local OpenAI-compatible `/v1/embeddings` (default LM Studio `http://127.0.0.1:1234/v1`
  with `bge-m3`). Stores compact Float32 vectors in SQLite (`post_embeddings`) for reuse by
  both classification and For You taste profiles. Classifies posts by cosine similarity against
  the 10 domain anchors + 6 content-form anchors. Fully resumable.

Stage 3 (`--stage llm`):
  Calls local non-reasoning OpenAI-compatible `/v1/chat/completions` (e.g. Qwen2.5-7B / Qwen3-8B
  in LM Studio or Ollama) ONLY on low-confidence or high-value ambiguous rows. Enforces strict
  `max_tokens=256`, strips `<think>...</think>`, and supports `--limit` dry-run testing.
"""

from __future__ import annotations

import argparse
import array
import json
import math
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

from taxonomy import (
    AUTHOR_DOMAIN_PRIORS,
    CLEANUP_FOLDER,
    CONTENT_FORM_SPECS,
    DOMAIN_NAMES,
    DOMAIN_SPECS,
    SPAM_GIVEAWAY_PATTERNS,
    TIER_A,
    TIER_B,
    TIER_D,
    TIER_S,
)

TS_2025_MS = 1735689600000  # 2025-01-01T00:00:00Z
TS_2026_MS = 1767225600000  # 2026-01-01T00:00:00Z

URL_RE = re.compile(r"https?://\S+")
THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.S | re.I)
JSON_OBJ_RE = re.compile(r"\{.*\}", re.S)


def ensure_loopback(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            f"Privacy guard: endpoint must be loopback (127.0.0.1/localhost), got '{endpoint}'. "
            "Pass --allow-remote only if you explicitly intend to call a remote server."
        )
    return endpoint.rstrip("/")


def http_post_json(url: str, payload: Dict[str, Any], api_key: str = "", timeout: int = 120) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def pack_f32(vec: Sequence[float]) -> bytes:
    arr = array.array("f", vec)
    return arr.tobytes()


def unpack_f32(blob: bytes) -> array.array:
    arr = array.array("f")
    arr.frombytes(blob)
    return arr


def l2_norm(vec: Sequence[float]) -> float:
    return math.sqrt(sum(x * x for x in vec))


def cosine(a: Sequence[float], b: Sequence[float], norm_a: Optional[float] = None, norm_b: Optional[float] = None) -> float:
    na = norm_a if norm_a is not None else l2_norm(a)
    nb = norm_b if norm_b is not None else l2_norm(b)
    if na == 0.0 or nb == 0.0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (na * nb)


def infer_content_forms(row: sqlite3.Row, text_low: str) -> List[str]:
    forms: List[str] = []
    domains = set(json.loads(row["domains_json"] or "[]"))
    text_len = len((row["text"] or "").strip())
    qtext_len = len((row["quoted_text"] or "").strip())
    qtitle = (row["quoted_article_title"] or "").strip()
    thread_len = int(row["thread_len"] or 0)
    has_article = int(row["has_article"] or 0)
    has_quote = int(row["has_quote"] or 0)
    has_image = int(row["has_image"] or 0)

    is_x_article = bool(has_article or qtitle)
    is_long_article = is_x_article or thread_len >= 2 or text_len >= 600
    is_long_quote = bool(has_quote and (text_len >= 260 or qtext_len >= 500 or qtitle))

    if is_long_article:
        forms.append("长文章")
    if is_x_article:
        forms.append("X文章")
    if is_long_quote:
        forms.append("长Quote")

    if domains & {"github.com", "gitlab.com", "npmjs.com", "pypi.org", "huggingface.co"} or any(
        k in text_low for k in ("open source", "github.com", "开源", "免费工具", "chrome 扩展")
    ):
        forms.append("开源工具")
    if any(k in text_low for k in ("how to", "step by step", "tutorial", "guide", "playbook", "教程", "指南", "保姆级", "实操", "步骤")):
        forms.append("干货教程")
    if is_long_article and "深度长文" not in forms:
        forms.append("深度长文")
    if any(k in text_low for k in ("list of", "top 10", "top 20", "curated", "cheatsheet", "合集", "清单", "汇总", "书单", "资源")):
        forms.append("资料清单")
    if has_image and any(k in text_low for k in ("design", "ui", "infographic", "chart", "审美", "信息图", "配色", "架构图")):
        forms.append("视觉素材")
    if not forms and text_len >= 120:
        forms.append("观点灵感")
    return forms[:5]


def estimate_tier(
    row: sqlite3.Row,
    domain: str,
    forms: List[str],
    is_spam: bool,
    is_empty_dead: bool,
    is_short_noise: bool,
    is_dup_quoted: bool = False,
    is_stale_low_signal: bool = False,
) -> Tuple[str, str]:
    if is_empty_dead:
        return TIER_D, "rule:deleted-empty"
    if is_spam:
        return TIER_D, "rule:spam-giveaway"
    if is_dup_quoted:
        return TIER_D, "rule:dup-quoted-copy"
    if is_short_noise:
        return TIER_D, "rule:ultra-short-noise"
    if is_stale_low_signal:
        return TIER_D, "rule:stale-low-signal"

    bookmarks = int(row["bookmarks"] or 0)
    text_len = len((row["text"] or "").strip())
    qtext_len = len((row["quoted_text"] or "").strip())
    qtitle = (row["quoted_article_title"] or "").strip()
    thread_len = int(row["thread_len"] or 0)
    has_article = int(row["has_article"] or 0)
    has_quote = int(row["has_quote"] or 0)
    created_ms = int(row["created_at"] or 0)
    domains = set(json.loads(row["domains_json"] or "[]"))
    has_code_or_paper = bool(domains & {"github.com", "arxiv.org", "huggingface.co"})

    # S-tier: X Articles (direct or quoted), multi-tweet threads, deep long-form tweets, deep long quotes, or top gems
    if has_article or qtitle or thread_len >= 2:
        return TIER_S, "rule:article-or-thread-s"
    if text_len >= 1000:
        return TIER_S, "rule:long-article-s"
    if has_quote and text_len >= 400:
        return TIER_S, "rule:long-quote-s"
    if created_ms >= TS_2026_MS and bookmarks >= 1000:
        return TIER_S, "rule:2026-gem-s"
    if TS_2025_MS <= created_ms < TS_2026_MS and bookmarks >= 1500:
        return TIER_S, "rule:2025-gem-s"
    if created_ms < TS_2025_MS and bookmarks >= 2500:
        return TIER_S, "rule:evergreen-gem-s"

    # A-tier: medium-long posts, substantive long quotes, or high-value reference kept in Hot Library
    if text_len >= 600:
        return TIER_A, "rule:long-post-a"
    if has_quote and (text_len >= 260 or (qtext_len >= 500 and text_len >= 60)):
        return TIER_A, "rule:long-quote-a"
    if created_ms >= TS_2026_MS and (bookmarks >= 600 or (has_code_or_paper and bookmarks >= 200)):
        return TIER_A, "rule:2026-useful-a"
    if TS_2025_MS <= created_ms < TS_2026_MS and (bookmarks >= 1000 or (has_code_or_paper and bookmarks >= 350)):
        return TIER_A, "rule:2025-useful-a"
    if created_ms < TS_2025_MS and bookmarks >= 2000:
        return TIER_A, "rule:evergreen-useful-a"

    # B-tier: solid archive kept in 冷库备查 (never deleted)
    return TIER_B, "rule:cold-b"


def find_duplicate_quoted_copies(conn: sqlite3.Connection) -> set:
    """For groups of posts quoting the exact same original tweet_id, keep the single richest
    post and only mark redundant copies whose own commentary is short (<100 chars) and not an article."""
    groups: Dict[str, List[Tuple[float, str, int, int]]] = {}
    for r in conn.execute(
        """
        SELECT tweet_id, json_extract(raw_json, '$.quoted.tweet_id') AS qid,
               bookmarks, likes, length(trim(text)) AS tlen, has_article
        FROM posts
        WHERE has_quote = 1 AND json_extract(raw_json, '$.quoted.tweet_id') IS NOT NULL
        """
    ):
        qid = str(r["qid"] or "").strip()
        if not qid:
            continue
        score = float(r["bookmarks"] or 0) * 2.0 + float(r["likes"] or 0) * 0.5 + float(r["tlen"] or 0) * 0.5
        groups.setdefault(qid, []).append((score, r["tweet_id"], int(r["tlen"] or 0), int(r["has_article"] or 0)))

    dup_copies = set()
    for qid, items in groups.items():
        if len(items) <= 1:
            continue
        items.sort(reverse=True)
        for _, tid, tlen, has_art in items[1:]:
            if tlen < 100 and not has_art:
                dup_copies.add(tid)
    return dup_copies


def run_stage_rules(conn: sqlite3.Connection, overwrite: bool = False) -> Dict[str, int]:
    t0 = time.time()
    dup_quoted_ids = find_duplicate_quoted_copies(conn)
    where_clause = "" if overwrite else "WHERE tweet_id NOT IN (SELECT tweet_id FROM classification WHERE stage IN ('embed', 'llm', 'manual'))"
    rows = conn.execute(
        f"""
        SELECT tweet_id, screen_name, created_at, text, quoted_text, quoted_article_title, status,
               domains_json, media_count, has_image, has_link, has_quote, has_article,
               thread_len, likes, bookmarks
        FROM posts {where_clause}
        """
    ).fetchall()

    now = int(time.time())
    updates: List[Tuple[Any, ...]] = []
    tier_counts: Dict[str, int] = {}
    confident_domain_count = 0

    for r in rows:
        text = (r["text"] or "").strip()
        qtext = (r["quoted_text"] or "").strip()
        qtitle = (r["quoted_article_title"] or "").strip()
        combined_low = f"{text}\n{qtext}\n{qtitle}".lower()
        domains = set(json.loads(r["domains_json"] or "[]"))
        author_low = (r["screen_name"] or "").lstrip("@").lower()
        created_ms = int(r["created_at"] or 0)

        is_empty_dead = (r["status"] == "tweet_deleted" and not text and not qtext) or (
            not text and not qtext and int(r["media_count"] or 0) == 0
        )
        is_spam = (
            any(pat in combined_low for pat in SPAM_GIVEAWAY_PATTERNS)
            and int(r["bookmarks"] or 0) < 300
            and int(r["has_article"] or 0) == 0
        )
        clean_no_url = URL_RE.sub("", text).strip()
        is_short_noise = (
            len(clean_no_url) < 35
            and not qtext
            and not qtitle
            and int(r["media_count"] or 0) == 0
            and int(r["has_link"] or 0) == 0
            and int(r["has_article"] or 0) == 0
            and int(r["bookmarks"] or 0) < 50
        )
        is_dup_quoted = r["tweet_id"] in dup_quoted_ids
        is_stale_low_signal = (
            created_ms > 0
            and created_ms < TS_2025_MS
            and len(clean_no_url) < 90
            and not qtext
            and not qtitle
            and int(r["has_article"] or 0) == 0
            and "github.com" not in domains
            and int(r["bookmarks"] or 0) < 30
        )

        # Score each domain via domain URLs (weight 3) + keyword hits (weight 1) + soft author prior (weight 1.5)
        author_prior = AUTHOR_DOMAIN_PRIORS.get(author_low, "")
        best_domain = ""
        best_score = 0.0
        second_score = 0.0
        hit_reason = ""
        for spec in DOMAIN_SPECS:
            sc = 0.0
            dom_hits = domains & set(spec.domains)
            if dom_hits:
                sc += 3.0 * len(dom_hits)
            kw_hits = 0
            for kw in spec.keywords:
                if kw in combined_low:
                    kw_hits += 1
            sc += kw_hits
            prior_hit = 1 if spec.name == author_prior else 0
            if prior_hit:
                sc += 1.5
            if sc > best_score:
                second_score = best_score
                best_score = sc
                best_domain = spec.name
                hit_reason = f"dom={len(dom_hits)},kw={kw_hits},prior={prior_hit}"
            elif sc > second_score:
                second_score = sc

        if best_score >= 2.0 and best_score > second_score:
            confidence = min(0.95, 0.55 + 0.1 * best_score)
            confident_domain_count += 1
        elif best_score >= 1.5:
            confidence = 0.65
            confident_domain_count += 1
        elif best_score >= 1.0:
            confidence = 0.45
        else:
            best_domain = ""
            confidence = 0.0

        forms = infer_content_forms(r, combined_low)
        tier, tier_reason = estimate_tier(
            r,
            best_domain,
            forms,
            is_spam,
            is_empty_dead,
            is_short_noise,
            is_dup_quoted=is_dup_quoted,
            is_stale_low_signal=is_stale_low_signal,
        )
        if tier == TIER_D:
            # Purely categorize into 待清理 folder (NEVER delete!)
            best_domain = CLEANUP_FOLDER
            confidence = max(confidence, 0.90)

        tier_counts[tier] = tier_counts.get(tier, 0) + 1
        updates.append(
            (
                r["tweet_id"],
                "rules",
                best_domain,
                json.dumps(forms, ensure_ascii=False),
                tier,
                round(confidence, 3),
                f"{tier_reason};{hit_reason}" if hit_reason else tier_reason,
                now,
            )
        )

    with conn:
        conn.executemany(
            """
            INSERT OR REPLACE INTO classification
                (tweet_id, stage, domain_folder, content_tags_json, tier, confidence, reason, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            updates,
        )

    elapsed = time.time() - t0
    print(
        f"[rules] Classified {len(updates):,} posts in {elapsed:.2f}s | "
        f"confident_domain={confident_domain_count:,} | tiers={tier_counts}"
    )
    return tier_counts


def build_post_embed_text(row: sqlite3.Row) -> str:
    parts = []
    if row["screen_name"]:
        parts.append(f"@{row['screen_name']}")
    if row["text"]:
        parts.append(row["text"][:1000])
    if row["quoted_article_title"]:
        parts.append(f"[Article] {row['quoted_article_title']}")
    if row["quoted_text"]:
        parts.append(f"[Quoted] {row['quoted_text'][:400]}")
    return "\n".join(parts).strip() or "(empty)"


def run_stage_embed(
    conn: sqlite3.Connection,
    endpoint: str,
    model: str,
    api_key: str,
    batch_size: int,
    limit: Optional[int],
    min_sim: float,
    hot_unclassified_only: bool = False,
    rescreen_weak: bool = False,
    assign_best: bool = False,
) -> Dict[str, int]:
    t0 = time.time()
    embed_url = f"{endpoint}/embeddings"

    # 1. Embed 10 domain anchors + 6 form anchors once
    print(f"[embed] Embedding {len(DOMAIN_SPECS)} domain anchors + {len(CONTENT_FORM_SPECS)} form anchors via {model}...", flush=True)
    domain_texts = [f"{s.name}: {s.anchor_text}" for s in DOMAIN_SPECS]
    form_names = list(CONTENT_FORM_SPECS.keys())
    form_texts = [f"{k}: {CONTENT_FORM_SPECS[k]}" for k in form_names]

    anchor_resp = http_post_json(embed_url, {"model": model, "input": domain_texts + form_texts}, api_key=api_key)
    anchor_data = sorted(anchor_resp["data"], key=lambda x: x["index"])
    anchor_vecs = [item["embedding"] for item in anchor_data]
    domain_vecs = anchor_vecs[: len(DOMAIN_SPECS)]
    domain_norms = [l2_norm(v) for v in domain_vecs]
    form_vecs = anchor_vecs[len(DOMAIN_SPECS) :]
    form_norms = [l2_norm(v) for v in form_vecs]

    # 2. Fetch posts needing embedding (skip tier:D deleted/spam shells to save time)
    if rescreen_weak:
        sql = """
            SELECT p.tweet_id, p.screen_name, p.text, p.quoted_text, p.quoted_article_title,
                   p.domains_json, p.has_image, p.has_article, p.thread_len, p.likes, p.bookmarks,
                   c.tier AS prev_tier, c.domain_folder AS prev_domain, c.confidence AS prev_conf,
                   c.content_tags_json AS prev_forms,
                   e.vector AS cached_vec
            FROM posts p
            JOIN classification c ON c.tweet_id = p.tweet_id
            LEFT JOIN post_embeddings e ON e.tweet_id = p.tweet_id AND e.model = ?
            WHERE c.tier != ?
              AND (
                c.domain_folder IS NULL OR c.domain_folder = ''
                OR (c.tier IN (?, ?) AND c.stage = 'rules' AND c.confidence <= 0.45)
              )
        """
        params: List[Any] = [model, TIER_D, TIER_S, TIER_A]
    elif hot_unclassified_only:
        sql = """
            SELECT p.tweet_id, p.screen_name, p.text, p.quoted_text, p.quoted_article_title,
                   p.domains_json, p.has_image, p.has_article, p.thread_len, p.likes, p.bookmarks,
                   c.tier AS prev_tier, c.domain_folder AS prev_domain, c.confidence AS prev_conf,
                   c.content_tags_json AS prev_forms,
                   e.vector AS cached_vec
            FROM posts p
            JOIN classification c ON c.tweet_id = p.tweet_id
            LEFT JOIN post_embeddings e ON e.tweet_id = p.tweet_id AND e.model = ?
            WHERE c.tier IN (?, ?)
              AND (c.domain_folder IS NULL OR c.domain_folder = '')
        """
        params = [model, TIER_S, TIER_A]
    else:
        sql = """
            SELECT p.tweet_id, p.screen_name, p.text, p.quoted_text, p.quoted_article_title,
                   p.domains_json, p.has_image, p.has_article, p.thread_len, p.likes, p.bookmarks,
                   c.tier AS prev_tier, c.domain_folder AS prev_domain, c.confidence AS prev_conf,
                   c.content_tags_json AS prev_forms,
                   NULL AS cached_vec
            FROM posts p
            LEFT JOIN classification c ON c.tweet_id = p.tweet_id
            WHERE p.tweet_id NOT IN (SELECT tweet_id FROM post_embeddings WHERE model = ?)
              AND (c.tier IS NULL OR c.tier != ?)
        """
        params = [model, TIER_D]

    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    todo = conn.execute(sql, params).fetchall()
    print(
        f"[embed] {len(todo):,} posts queued for embedding "
        f"(batch_size={batch_size}, hot_unclassified_only={hot_unclassified_only}, assign_best={assign_best})...",
        flush=True,
    )

    processed = 0
    classified = 0
    sims: List[float] = []
    domain_counts: Dict[str, int] = {}
    now = int(time.time())

    for start in range(0, len(todo), batch_size):
        chunk = todo[start : start + batch_size]
        need_api_indices = [i for i, r in enumerate(chunk) if r["cached_vec"] is None]
        vecs: List[Optional[Sequence[float]]] = [
            unpack_f32(r["cached_vec"]) if r["cached_vec"] is not None else None for r in chunk
        ]
        if need_api_indices:
            texts = [build_post_embed_text(chunk[i]) for i in need_api_indices]
            resp = http_post_json(embed_url, {"model": model, "input": texts}, api_key=api_key)
            embs = [item["embedding"] for item in sorted(resp["data"], key=lambda x: x["index"])]
            for idx_in_chunk, emb in zip(need_api_indices, embs):
                vecs[idx_in_chunk] = emb

        emb_rows = []
        cls_rows = []
        for idx_in_chunk, (r, vec) in enumerate(zip(chunk, vecs)):
            assert vec is not None
            vnorm = l2_norm(vec)
            if r["cached_vec"] is None:
                emb_rows.append((r["tweet_id"], model, len(vec), pack_f32(vec), now))

            # Best domain anchor
            dom_scores = [
                (cosine(vec, dv, vnorm, dn), DOMAIN_SPECS[idx].name)
                for idx, (dv, dn) in enumerate(zip(domain_vecs, domain_norms))
            ]
            dom_scores.sort(reverse=True)
            top_sim, top_dom = dom_scores[0]
            second_sim = dom_scores[1][0] if len(dom_scores) > 1 else 0.0
            margin = top_sim - second_sim
            sims.append(top_sim)

            # Best form tags
            existing_forms = json.loads(r["prev_forms"] or "[]")
            form_scores = [
                (cosine(vec, fv, vnorm, fn), form_names[idx])
                for idx, (fv, fn) in enumerate(zip(form_vecs, form_norms))
            ]
            form_scores.sort(reverse=True)
            forms = list(existing_forms)
            if form_scores and form_scores[0][0] >= min_sim and form_scores[0][1] not in forms:
                forms.append(form_scores[0][1])
            forms = forms[:5]

            # Keep strong rule domain if confidence >= 0.80, else adopt vector domain if >= min_sim (or assign_best)
            prev_conf = float(r["prev_conf"] or 0.0)
            prev_dom = r["prev_domain"] or ""
            if prev_dom and prev_conf >= 0.80:
                chosen_dom = prev_dom
                conf = max(prev_conf, top_sim)
                reason = f"rules+embed:top={top_dom}({top_sim:.2f})"
            elif top_sim >= min_sim:
                chosen_dom = top_dom
                conf = min(0.95, max(0.50, top_sim + margin * 0.8))
                reason = f"embed:sim={top_sim:.2f},margin={margin:.2f}"
                classified += 1
            elif assign_best:
                chosen_dom = top_dom
                conf = round(max(0.25, top_sim), 3)
                reason = f"embed:best={top_sim:.2f},margin={margin:.2f}"
                classified += 1
            else:
                chosen_dom = prev_dom
                conf = min(prev_conf, top_sim)
                reason = f"embed:low-sim={top_sim:.2f}"

            if chosen_dom:
                domain_counts[chosen_dom] = domain_counts.get(chosen_dom, 0) + 1

            # Preserve tier from rules stage (only promote tier:B when NOT rescreen_weak so cold archive stays disciplined)
            tier = r["prev_tier"] or TIER_A
            if (
                not rescreen_weak
                and tier == TIER_B
                and chosen_dom in ("AI工具与工作流", "编程与技术开发", "投资理财与宏观", "效率与知识管理", "职业与副业营销", "认知心理与深度思考")
                and conf >= 0.65
            ):
                tier = TIER_A

            cls_rows.append(
                (
                    r["tweet_id"],
                    "embed",
                    chosen_dom,
                    json.dumps(forms, ensure_ascii=False),
                    tier,
                    round(conf, 3),
                    reason,
                    now,
                )
            )

        with conn:
            if emb_rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO post_embeddings (tweet_id, model, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)",
                    emb_rows,
                )
            conn.executemany(
                """
                INSERT OR REPLACE INTO classification
                    (tweet_id, stage, domain_folder, content_tags_json, tier, confidence, reason, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                cls_rows,
            )

        processed += len(chunk)
        if processed % (batch_size * 3) == 0 or processed == len(todo):
            elapsed = time.time() - t0
            rate = processed / max(elapsed, 0.01)
            print(f"[embed] {processed:,}/{len(todo):,} done ({rate:.1f} posts/s)", flush=True)

    if sims:
        sims.sort()
        n = len(sims)
        print(
            f"[embed] top_sim quantiles: min={sims[0]:.3f} p10={sims[int(n*0.1)]:.3f} "
            f"p50={sims[int(n*0.5)]:.3f} p90={sims[int(n*0.9)]:.3f} max={sims[-1]:.3f}",
            flush=True,
        )
        print(f"[embed] classified={classified:,}/{processed:,} | domains={domain_counts}", flush=True)

    return {"embedded": processed, "classified": classified}


LLM_SYSTEM_PROMPT = f"""你是一个严格的 X (Twitter) 书签分类器。只输出合法 JSON，不要输出任何额外说明或思考过程。
一级领域 domain 必须从以下 10 项中严格单选：
{json.dumps(DOMAIN_NAMES, ensure_ascii=False)}
内容形态 tags 从以下 6 项中选 0-2 个：
{json.dumps(list(CONTENT_FORM_SPECS.keys()), ensure_ascii=False)}
价值层级 tier 必须从以下 4 项中严格单选：
- "{TIER_S}"：深度长文、极高质量教程/开源工具/高信息密度洞察
- "{TIER_A}"：有参考价值的技术、投资、营销、效率或生活实用帖
- "{TIER_B}"：一般性新闻、随手收藏、留冷库备查即可
- "{TIER_D}"：抽奖、营销引流、空洞水帖、纯情绪无信息量内容，建议取消收藏

严格输出 JSON 格式：
{{"domain": "...", "tags": ["..."], "tier": "...", "reason": "15字以内简短理由"}}"""


def parse_llm_json(content: str) -> Optional[Dict[str, Any]]:
    cleaned = THINK_TAG_RE.sub("", content or "").strip()
    m = JSON_OBJ_RE.search(cleaned)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    dom = obj.get("domain")
    tier = obj.get("tier")
    if dom not in DOMAIN_NAMES:
        return None
    if tier not in (TIER_S, TIER_A, TIER_B, TIER_D):
        tier = TIER_A
    raw_tags = obj.get("tags") or []
    tags = [t for t in raw_tags if isinstance(t, str) and t in CONTENT_FORM_SPECS][:2]
    reason = str(obj.get("reason") or "")[:60]
    return {"domain": dom, "tags": tags, "tier": tier, "reason": reason}


def run_stage_llm(
    conn: sqlite3.Connection,
    endpoint: str,
    model: str,
    api_key: str,
    max_conf: float,
    limit: Optional[int],
) -> Dict[str, int]:
    t0 = time.time()
    chat_url = f"{endpoint}/chat/completions"

    sql = """
        SELECT p.tweet_id, p.screen_name, p.text, p.quoted_text, p.quoted_article_title,
               p.likes, p.bookmarks, c.confidence, c.domain_folder, c.tier
        FROM posts p
        LEFT JOIN classification c ON c.tweet_id = p.tweet_id
        WHERE (c.stage IS NULL OR c.stage NOT IN ('llm', 'manual'))
          AND (c.tier IS NULL OR c.tier != ?)
          AND (c.domain_folder IS NULL OR c.domain_folder = '' OR c.confidence < ?)
        ORDER BY p.bookmarks DESC, p.likes DESC
    """
    params: List[Any] = [TIER_D, max_conf]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    todo = conn.execute(sql, params).fetchall()
    print(f"[llm] {len(todo):,} ambiguous/uncategorized posts queued for {model}...", flush=True)

    ok_count = 0
    fail_count = 0
    now = int(time.time())

    for idx, r in enumerate(todo, 1):
        snippet = build_post_embed_text(r)[:900]
        user_msg = f"作者: @{r['screen_name']} | 赞:{r['likes']} 藏:{r['bookmarks']}\n内容:\n{snippet}"
        payload = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": 256,
            "messages": [
                {"role": "system", "content": LLM_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        }
        try:
            resp = http_post_json(chat_url, payload, api_key=api_key, timeout=90)
            content = resp["choices"][0]["message"]["content"]
            parsed = parse_llm_json(content)
            if not parsed:
                fail_count += 1
                continue
            with conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO classification
                        (tweet_id, stage, domain_folder, content_tags_json, tier, confidence, reason, updated_at)
                    VALUES (?, 'llm', ?, ?, ?, 0.88, ?, ?)
                    """,
                    (
                        r["tweet_id"],
                        parsed["domain"],
                        json.dumps(parsed["tags"], ensure_ascii=False),
                        parsed["tier"],
                        f"llm:{parsed['reason']}",
                        now,
                    ),
                )
            ok_count += 1
        except Exception as exc:
            fail_count += 1
            print(f"[llm] warn tweet_id={r['tweet_id']}: {exc}", file=sys.stderr)

        if idx % 25 == 0 or idx == len(todo):
            elapsed = time.time() - t0
            print(f"[llm] {idx:,}/{len(todo):,} processed (ok={ok_count}, fail={fail_count}, {elapsed:.1f}s)", flush=True)

    return {"ok": ok_count, "fail": fail_count}


def main() -> int:
    parser = argparse.ArgumentParser(description="3-stage local funnel classifier for X bookmarks.")
    parser.add_argument("--db", type=Path, default=Path("data_sandbox/cold_archive.db"))
    parser.add_argument("--stage", required=True, choices=("rules", "embed", "llm"))
    parser.add_argument("--endpoint", default="http://127.0.0.1:1234/v1", help="Local LM Studio / Ollama OpenAI endpoint")
    parser.add_argument("--model", default="", help="Model id (default: bge-m3 for embed, qwen2.5-7b-instruct for llm)")
    parser.add_argument("--api-key", default="", help="Optional API key (leave empty for local LM Studio/Ollama)")
    parser.add_argument("--allow-remote", action="store_true", help="Explicitly allow non-loopback endpoint")
    parser.add_argument("--batch-size", type=int, default=64, help="Embedding batch size (default: 64)")
    parser.add_argument("--min-sim", type=float, default=0.48, help="Min cosine similarity for vector domain match")
    parser.add_argument("--max-conf", type=float, default=0.62, help="Max confidence threshold for LLM fallback stage")
    parser.add_argument("--limit", type=int, default=None, help="Process only N rows (great for 100-item dry-run)")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing classifications in rules stage")
    parser.add_argument(
        "--hot-unclassified-only",
        action="store_true",
        help="In embed stage, only process tier:S / tier:A hot-library rows that have no domain_folder yet",
    )
    parser.add_argument(
        "--rescreen-weak",
        action="store_true",
        help="In embed stage, classify ALL unclassified non-D rows + re-verify weak-rule (conf<=0.45) hot rows",
    )
    parser.add_argument(
        "--assign-best",
        action="store_true",
        help="In embed stage, assign the highest-similarity domain anchor even if below --min-sim",
    )
    args = parser.parse_args()

    if not args.db.exists():
        raise FileNotFoundError(f"Cold archive DB not found: {args.db}")

    conn = sqlite3.connect(str(args.db))
    conn.row_factory = sqlite3.Row
    try:
        if args.stage == "rules":
            run_stage_rules(conn, overwrite=args.overwrite)
        else:
            endpoint = args.endpoint.rstrip("/") if args.allow_remote else ensure_loopback(args.endpoint)
            if args.stage == "embed":
                model = args.model or "bge-m3"
                run_stage_embed(
                    conn,
                    endpoint,
                    model,
                    args.api_key,
                    args.batch_size,
                    args.limit,
                    args.min_sim,
                    hot_unclassified_only=args.hot_unclassified_only,
                    rescreen_weak=args.rescreen_weak,
                    assign_best=args.assign_best,
                )
            elif args.stage == "llm":
                model = args.model or "qwen2.5-7b-instruct"
                run_stage_llm(conn, endpoint, model, args.api_key, args.max_conf, args.limit)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
