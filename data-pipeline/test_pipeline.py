#!/usr/bin/env python3
"""End-to-end automated self-test for data-pipeline/ using synthetic multi-account data
and a local mock OpenAI-compatible server (testing all 4 scripts without external deps)."""

from __future__ import annotations

import http.server
import importlib.util
import json
import socketserver
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

PIPELINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINE_DIR))


def load_mod(name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, PIPELINE_DIR / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod_import = load_mod("step1", "01_import_to_sqlite.py")
mod_audit = load_mod("step2", "02_audit_health.py")
mod_cls = load_mod("step3", "03_funnel_classify.py")
mod_export = load_mod("step4", "04_export_outputs.py")


def build_mock_backup() -> dict:
    return {
        "format": "x-toolkit-full",
        "version": 1,
        "app": "x-toolkit",
        "appVersion": "0.7.20",
        "exportedAt": "2026-11-26T12:00:00.000Z",
        "secretsIncluded": False,
        "omittedSecrets": [],
        "strike": {"schema": 1, "settings": {}, "ledger": {}, "tweets": {}, "hidden": {}, "queue": [], "log": [], "undo": [], "aiCache": {}, "hitLog": [], "vetoes": [], "rate": {}},
        "storage": {"settings": {}, "accounts": {}, "queryIds": {}, "libraryColumns": None, "lastFullSync": None},
        "bookmarks": {
            "folders": [{"name": "old-folder", "source": "local", "created_at": 1700000000000}],
            "posts": [
                {
                    "tweet_id": "1001",
                    "sort_index": "00000001001",
                    "user_id": "u1",
                    "screen_name": "ai_builder",
                    "name": "AI Builder",
                    "avatar": "",
                    "created_at": 1760000000000,
                    "saved_at": 1760000100000,
                    "text": "How to build a production Claude Code + MCP agent workflow step by step. Full GitHub repo included!",
                    "lang": "en",
                    "urls": ["https://github.com/example/claude-mcp-kit"],
                    "media": [],
                    "metrics": {"replies": 50, "retweets": 300, "likes": 3200, "quotes": 40, "bookmarks": 1800, "views": 95000},
                    "has_image": 0, "has_video": 0, "has_link": 1, "has_quote": 0, "has_article": 0,
                    "folder": "", "tags": ["saved"], "status": "active", "sync_run": "r1",
                    "url": "https://x.com/ai_builder/status/1001",
                    "source": "bookmark", "accounts": ["main_acc", "alt_acc"],
                },
                {
                    "tweet_id": "1002",
                    "sort_index": "00000001002",
                    "user_id": "u2",
                    "screen_name": "spam_promo",
                    "name": "Promo",
                    "avatar": "",
                    "created_at": 1760000000000,
                    "saved_at": 1760000200000,
                    "text": "HUGE GIVEAWAY! Retweet and follow + comment \"AI\" below and I'll DM you my free PDF!",
                    "lang": "en",
                    "urls": ["https://t.co/xyz123"],
                    "media": [],
                    "metrics": {"replies": 400, "retweets": 200, "likes": 120, "quotes": 2, "bookmarks": 30, "views": 8000},
                    "has_image": 0, "has_video": 0, "has_link": 1, "has_quote": 0, "has_article": 0,
                    "folder": "", "tags": [], "status": "active", "sync_run": "r1",
                    "url": "https://x.com/spam_promo/status/1002",
                    "source": "bookmark", "accounts": ["main_acc"],
                },
                {
                    "tweet_id": "1003",
                    "sort_index": "00000001003",
                    "user_id": "u3",
                    "screen_name": "deleted_user",
                    "name": "",
                    "avatar": "",
                    "created_at": 1750000000000,
                    "saved_at": 1750000100000,
                    "text": "",
                    "lang": "",
                    "urls": [], "media": [],
                    "metrics": {"replies": 0, "retweets": 0, "likes": 0, "quotes": 0, "bookmarks": 0, "views": 0},
                    "has_image": 0, "has_video": 0, "has_link": 0, "has_quote": 0, "has_article": 0,
                    "folder": "", "tags": [], "status": "tweet_deleted", "sync_run": "r1",
                    "url": "https://x.com/deleted_user/status/1003",
                    "source": "bookmark", "accounts": ["alt_acc"],
                },
                {
                    "tweet_id": "1004",
                    "sort_index": "00000001004",
                    "user_id": "u4",
                    "screen_name": "short_react",
                    "name": "React",
                    "avatar": "",
                    "created_at": 1760000000000,
                    "saved_at": 1760000400000,
                    "text": "haha so true lol",
                    "lang": "en",
                    "urls": [], "media": [],
                    "metrics": {"replies": 1, "retweets": 0, "likes": 12, "quotes": 0, "bookmarks": 3, "views": 200},
                    "has_image": 0, "has_video": 0, "has_link": 0, "has_quote": 0, "has_article": 0,
                    "folder": "", "tags": [], "status": "active", "sync_run": "r1",
                    "url": "https://x.com/short_react/status/1004",
                    "source": "bookmark", "accounts": ["alt_acc"],
                },
                {
                    "tweet_id": "1005",
                    "sort_index": "00000001005",
                    "user_id": "u5",
                    "screen_name": "deep_writer",
                    "name": "Deep Writer",
                    "avatar": "",
                    "created_at": 1760000000000,
                    "saved_at": 1760000500000,
                    "text": "1/ A long thoughtful reflection on why calm deliberate strategy outperforms frantic activity over a decade of compounding. Here is what I noticed working across teams in Asia and Europe...",
                    "lang": "en",
                    "urls": [], "media": [],
                    "metrics": {"replies": 30, "retweets": 80, "likes": 900, "quotes": 15, "bookmarks": 650, "views": 40000},
                    "has_image": 0, "has_video": 0, "has_link": 0, "has_quote": 0, "has_article": 0,
                    "folder": "", "tags": [], "status": "active", "sync_run": "r1",
                    "url": "https://x.com/deep_writer/status/1005",
                    "source": "bookmark", "accounts": ["main_acc"],
                },
            ],
        },
    }


class MockLocalAIHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if self.path.endswith("/embeddings"):
            inputs = body.get("input") or []
            data = []
            for idx, text in enumerate(inputs):
                low = str(text).lower()
                # Simple deterministic 4-dim semantic mock vector
                v = [
                    1.0 if ("ai" in low or "claude" in low or "mcp" in low) else 0.1,
                    1.0 if ("strategy" in low or "reflection" in low or "思考" in low or "认知" in low) else 0.1,
                    1.0 if ("tutorial" in low or "how to" in low or "教程" in low) else 0.1,
                    0.2,
                ]
                data.append({"index": idx, "embedding": v})
            resp = {"data": data}
        elif self.path.endswith("/chat/completions"):
            resp = {
                "choices": [
                    {
                        "message": {
                            "content": '<think>reasoning test</think>{"domain":"认知心理与深度思考","tags":["深度长文","观点灵感"],"tier":"tier:S-核心精华","reason":"高密度战略思考串推"}'
                        }
                    }
                ]
            }
        else:
            self.send_response(404)
            self.end_headers()
            return

        out = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def run_test() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        raw_json = tmp_path / "backup.json"
        db_path = tmp_path / "cold_archive.db"
        report_path = tmp_path / "health_report.md"
        out_dir = tmp_path / "out"

        raw_json.write_text(json.dumps(build_mock_backup(), ensure_ascii=False), encoding="utf-8")

        # 1. Import
        res_imp = mod_import.import_files([raw_json], db_path)
        assert res_imp["unique_total"] == 5, res_imp

        # 2. Audit
        res_aud = mod_audit.run_audit(db_path, report_path)
        assert res_aud["total"] == 5
        assert res_aud["spam_giveaway_suspects"] == 1
        assert res_aud["ultra_short_no_media"] == 1
        assert res_aud["incomplete_thread_suspects"] == 1
        assert report_path.exists()

        # 3. Stage 1: Rules
        import sqlite3

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        tiers = mod_cls.run_stage_rules(conn)
        assert tiers.get("tier:D-低质待清") == 3, tiers  # spam + deleted + short react
        assert tiers.get("tier:S-核心精华", 0) >= 1, tiers

        # 4. Stage 2 & 3 against local mock server
        server = socketserver.TCPServer(("127.0.0.1", 0), MockLocalAIHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            endpoint = f"http://127.0.0.1:{port}/v1"
            res_emb = mod_cls.run_stage_embed(conn, endpoint, "bge-m3", "", batch_size=8, limit=None, min_sim=0.50)
            assert res_emb["embedded"] == 2, res_emb  # skips 3 tier:D items!

            # Force one low-confidence row to exercise LLM fallback + <think> stripping
            conn.execute("UPDATE classification SET confidence = 0.30, domain_folder = '' WHERE tweet_id = '1005'")
            conn.commit()
            res_llm = mod_cls.run_stage_llm(conn, endpoint, "qwen-mock", "", max_conf=0.60, limit=10)
            assert res_llm["ok"] == 1, res_llm
            row_1005 = conn.execute("SELECT domain_folder, tier FROM classification WHERE tweet_id='1005'").fetchone()
            assert row_1005["domain_folder"] == "认知心理与深度思考", dict(row_1005)
            assert row_1005["tier"] == "tier:S-核心精华", dict(row_1005)
        finally:
            server.shutdown()
            server.server_close()
            conn.close()

        # 5. Export
        res_exp = mod_export.export_outputs(db_path, out_dir, hot_tiers={"tier:S-核心精华", "tier:A-有用参考"})
        assert res_exp["hot_count"] == 2, res_exp
        assert res_exp["cleanup_count"] == 2, res_exp  # 1002 + 1004 (1003 is tweet_deleted, not active)

        hot_data = json.loads((out_dir / "hot_library_backup.json").read_text(encoding="utf-8"))
        assert hot_data["format"] == "x-toolkit-full"
        assert len(hot_data["bookmarks"]["posts"]) == 2
        cleanup_data = json.loads((out_dir / "cleanup_queue_by_account.json").read_text(encoding="utf-8"))
        assert cleanup_data["format"] == "x-toolkit-cleanup-queue"
        assert cleanup_data["accounts"]["main_acc"]["count"] == 1
        assert cleanup_data["accounts"]["alt_acc"]["count"] == 1
        assert (out_dir / "cleanup_review.md").exists()
        assert (out_dir / "hot_cold_summary.md").exists()
        print("ALL PIPELINE E2E TESTS PASSED!")


if __name__ == "__main__":
    run_test()
