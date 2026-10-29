# 贡献指南 / Contributing

感谢你对 **Bookmark Keeper** 的兴趣。本项目是 Chrome MV3 扩展（X / Twitter 书签与公开发帖本地管理）。

## 开始之前

1. 阅读 [README.md](./README.md) 中的风险与免责声明：本扩展使用 X 网页端内部 GraphQL，**可能违反服务条款**，且**未对真实 X 账号做端到端验证**。
2. 阅读 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) 了解目录与构建方式。
3. 请勿在 Issue / PR / 提交中粘贴真实 cookie、token、Bearer、API Key 或个人书签数据。

## 开发流程（简要）

```bash
npm install
npm run typecheck
npm test
npm run build
# 可选: npm run e2e   # 需本机 Chrome + openssl
```

在 `chrome://extensions` 以「开发者模式」加载 `dist/` 做手动验证。

## 提交建议

- **只改与目标相关的文件**；不要顺手格式化无关代码。
- 业务逻辑变更请附带或更新 `tests/` 中的单测；涉及解析器时优先用 `tests/fixtures` 手工构造的响应，勿提交真实抓包。
- UI 文案走 `src/ui/i18n.tsx`，尽量同时维护中英文。
- 新增对外部域名的网络请求时，说明权限与隐私影响。
- Commit 信息用中文或英文均可，说明「改了什么 / 为什么」。

## Pull Request

- 描述问题与复现步骤（若有）；说明测试方式（`npm test` / 手动 / Mock e2e）。
- 若触及鉴权、queryId、features 或限流逻辑，在 PR 中写明假设与回退路径。
- 维护者可能要求补充单测或缩小改动范围后再合并。

## 行为准则

保持友善与建设性讨论。恶意利用、帮助绕过账号安全或公开他人隐私数据的贡献不会被接受。

有疑问可开 Issue 讨论设计，再动手写大改动。
