# X 书签本地离线体检与三阶段清洗流水线 (`data-pipeline/`)

> **零外部 Python 依赖 · 100% 本地运行 · 严禁上传隐私数据**
> 所有原始书签 JSON、SQLite 冷库与导出产物均放置在 `data_sandbox/` 目录（已在 `.gitignore` 中严格屏蔽，绝不会提交到 GitHub）。

---

## 第一步：从 Chrome 扩展安全导出你的 115MB 书签数据

1. 打开当前安装的 **X Toolkit** 扩展 → 进入 **设置（Settings）→ 数据**；
2. 点击 **「一键全量备份」**（导出 `x-toolkit-full-backup-YYYY-MM-DD.json`，默认**不要**勾选包含 API Key / 会话凭证）；
   - *如果你希望按账号分别备份，也可使用「按账号导出」，本流水线支持一次性传入多个 JSON 文件并自动无损合并*。
3. 把导出的 JSON 文件放入本仓库根目录下的 `data_sandbox/` 文件夹（如 `data_sandbox/raw_backup.json`）。

---

## 第二步：一键入库 SQLite 冷库 + 输出五维体检报告（约 15 秒）

```bash
# 1. 先只探测数据结构（不写盘，验证格式无误）
python3 data-pipeline/01_import_to_sqlite.py data_sandbox/raw_backup.json --inspect

# 2. 全量无损导入本地 SQLite 永久冷库 + FTS5 全文检索索引
python3 data-pipeline/01_import_to_sqlite.py data_sandbox/raw_backup.json

# 3. 生成 6 万条完整性与体积体检报告 -> data_sandbox/health_report.md
python3 data-pipeline/02_audit_health.py
```

---

## 第三步：三阶段纯本地漏斗清洗与分类

### Stage 1：离线规则初筛（< 30 秒，零模型依赖）
自动识别已删空壳、抽奖/互关垃圾、超短水帖，并按高频域名与强关键词先分出一批明确领域：

```bash
python3 data-pipeline/03_funnel_classify.py --stage rules
```

### Stage 2：M5 Pro 本地 `bge-m3` 语义向量分类（约 10–15 分钟）
1. 在 Mac 上安装 **LM Studio**（[lmstudio.ai](https://lmstudio.ai)），搜索并下载 `bge-m3`（如 `BAAI/bge-m3` GGUF）；
2. 在 LM Studio 左侧 **Developer / Local Server** 启动本地服务（默认 `http://127.0.0.1:1234/v1`）；
3. 先用 `--limit 200` 试跑验证，再跑全量（自动断点续传，向量同步缓存在 SQLite 中可供 v2 For You 复用）：

```bash
# 小样本试跑 200 条
python3 data-pipeline/03_funnel_classify.py --stage embed --model bge-m3 --limit 200

# 确认无误后跑全量（中断后重跑会自动跳过已完成条目）
python3 data-pipeline/03_funnel_classify.py --stage embed --model bge-m3
```

### Stage 3：本地轻量非推理 LLM 边界兜底（仅处理低置信/高价值边界样本）
1. 在 LM Studio 加载轻量非推理模型（推荐 `Qwen2.5-7B-Instruct` Q4_K_M，速度快、无冗长思考链）；
2. 先试跑 100 条检查效果，再按需放开：

```bash
python3 data-pipeline/03_funnel_classify.py --stage llm --model qwen2.5-7b-instruct --limit 100
```

---

## 第四步：分流导出「精选热库」与「按账号 X 清理队列」

```bash
python3 data-pipeline/04_export_outputs.py
```

产物将全部生成在 `data_sandbox/out/`：
- `hot_library_backup.json`：仅保留 `tier:S` + `tier:A` 精选书签与新领域文件夹，体积大幅瘦身，可直接导入 Chrome 扩展；
- `cleanup_queue_by_account.json`：按收藏账号分好组的 X 端待取消收藏队列 + 冷库墓碑 ID 列表；
- `cleanup_review.md`：人工复核清单一览（确认无误再交给 v2 扩展分批限速取消收藏）；
- `hot_cold_summary.md`：瘦身前后体积与 10 大领域分布汇总。
