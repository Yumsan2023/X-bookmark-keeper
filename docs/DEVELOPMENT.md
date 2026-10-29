# 开发与目录结构

面向贡献者与想改代码的用户。日常使用请看 [USAGE.md](./USAGE.md) 与 [README.md](../README.md)。

## 环境要求

- Node.js（建议当前 LTS）与 npm  
- Chrome ≥ 114（扩展 `minimum_chrome_version`）  
- 可选 e2e：本机 Chrome 可执行文件（`CHROME_BIN`）、`openssl`、puppeteer-core（已在 devDependencies）

## 常用命令

```bash
npm install          # 安装依赖
npm run typecheck    # tsc --noEmit
npm test             # vitest 单元测试
npm run build        # 类型检查 + Vite 构建 → dist/
npm run dev          # vite build --watch；改完在 chrome://extensions 点「重新加载」
npm run icons        # 重新生成 public/icons（scripts/gen-icons.mjs）
npm run e2e          # 需先 build；真实 Chrome + 本地 Mock X（自签名 HTTPS）
```

加载扩展时永远指向 **`dist/`**（内含构建后的 `manifest.json`）。

## 目录一览

```
bookmark-keeper/
├── public/                 # 静态资源，构建时拷入 dist
│   ├── manifest.json       # MV3 清单（手写，不依赖 crxjs）
│   └── icons/
├── src/
│   ├── background/         # Service Worker
│   │   ├── index.ts        # SW 入口
│   │   ├── auth-capture.ts # webRequest 抓 Bearer/csrf/uuid/txn-id，学习 queryId
│   │   ├── dnr.ts          # declarativeNetRequest：扩展→x.com 请求改 Origin/Referer
│   │   ├── queryids.ts     # 学到的 > bundle 扫描 > 默认值
│   │   ├── sync-engine.ts  # 书签全量/增量、断点、429
│   │   ├── timeline-engine.ts  # UserTweets 发帖同步
│   │   ├── actions.ts      # 批量取消书签、推文件夹、抓线程等
│   │   └── messaging.ts    # runtime.onMessage 路由
│   ├── api/
│   │   ├── client.ts       # fetch + credentials、超时、限流头、404/400 恢复
│   │   ├── endpoints.ts    # 默认 queryId
│   │   ├── features.ts
│   │   ├── parser.ts       # GraphQL JSON → Post（纯函数，易测）
│   │   ├── queryid-discovery.ts
│   │   ├── handle.ts       # screen_name / 当前账号解析
│   │   └── errors.ts
│   ├── db/                 # Dexie：posts / folders / searchMeta
│   ├── search/             # MiniSearch、query-parser、tokenizer、highlight、service
│   ├── export/             # json/csv/markdown/obsidian zip/batch/media
│   ├── ai/                 # OpenAI 兼容归类
│   ├── shared/             # types、storage
│   └── ui/                 # React：options / sidepanel / popup / print
│       └── components/library/  # v0.4 列表页 LibraryView + Filter/Export 面板
├── tests/                  # vitest + fixtures/builders（手工 GraphQL 形状）
├── e2e/                    # Mock X + puppeteer 冒烟
├── scripts/gen-icons.mjs
├── docs/                   # USAGE / DEVELOPMENT
├── vite.config.ts          # 多入口：background.js + 四个 HTML
├── vitest.config.ts
└── package.json
```

## 构建模型

- **多入口**：`public/manifest.json` + Vite；background 产出固定名 `background.js`（ES module）；`options.html` / `sidepanel.html` / `popup.html` / `print.html` 各为 UI 入口。  
- **不依赖 crxjs**。  
- 源码仓 `.gitignore` 忽略 `dist/` 与 `node_modules/`；发布可用 GitHub Releases 附带含 `dist` 的 zip，方便用户免构建加载。

## 架构要点（实现约束）

1. **鉴权**：只从用户已打开的 x.com 页面请求头学习凭证；后续 `fetch(..., { credentials: 'include' })` 带 cookie。勿把真实 token 写入仓库或测试夹具。  
2. **queryId**：页面学习 → 404/unknown 时扫 bundle → `DEFAULT_QUERY_IDS` 兜底。  
3. **features**：400「features cannot be null」时自动补 `false` 并记住。  
4. **书签 vs 发帖**：`Post.source` 为 `bookmark` | `timeline`；时间线进 `timeline:@handle`；已是书签的 id 不降级。  
5. **大库**：UI 禁止 `toArray()` 全表开机；空查询走 Dexie 分页；全文优先持久化 MiniSearch，否则 idle 分批建索引。 列表页（`LibraryView`）同样只走 `lib.search` / `collectAllMatching`，禁止整库 `getAllPosts` 渲染。  
6. **测试**：单元测试用 `tests/fixtures` 构造响应；e2e 用本地 Mock，**禁止**依赖真实账号或提交抓包中的 cookie。

## 改代码时的建议落点

| 目标 | 优先查看 |
| --- | --- |
| 新 GraphQL 操作 / 默认 queryId | `api/endpoints.ts`、`queryids.ts`、`queryid-discovery.ts` |
| 响应字段变化 | `api/parser.ts` + `tests/parser.test.ts` |
| 同步策略 / 限流 | `background/sync-engine.ts`、`timeline-engine.ts`、`api/client.ts` |
| 搜索语法 | `search/query-parser.ts` |
| 导出格式 | `export/*` |
| UI 文案 | `ui/i18n.tsx` |
| 权限 / 主机 | `public/manifest.json` |

## e2e 说明

`npm run e2e` 会：

1. 用 openssl 生成短时自签名证书；  
2. 启动 Mock X（HTTPS），并用 Chrome `--host-resolver-rules` 把 `x.com` / `abs.twimg.com` 指到本机；  
3. 加载 `dist/` 扩展，冒烟：凭证捕获、queryId 刷新、分页、429、DNR、UI 搜索等。

这验证的是**扩展自身流水线**，不证明真实 X 仍接受相同请求。

## 提交前自检

```bash
npm run typecheck && npm test && npm run build
```

勿提交：`node_modules/`、`.env*`、真实 cookie/token、个人导出数据、意外的 `*.zip`（发布 zip 由维护者在 Releases 上传，不进 git）。
