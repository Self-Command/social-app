# AGENTS.workspace.md — social-app 企业叠加规则

> 本文件由工作区维护，补充上游 `AGENTS.md`，不替代它。
> 开始任务前依次阅读：工作区根 `AGENTS.md` → 本文件 → 上游 `AGENTS.md`。
> 规则冲突、需要改变策略或发现阻塞时，必须停止并向用户提问，等待裁决。

## 1. 环境

- Node 必须 `>=24.22.1`；本机使用 `H:\Dev\Tools\node-24.22.1`。
- 包管理器使用 pnpm 11.28.5（`devEngines.packageManager`）；必须显式 `corepack pnpm@11.28.5`，直接 `corepack pnpm` 会报 `packages field missing or empty`。
- 依赖安装、原生构建、E2E 属于大动作，先征得用户同意。

```bash
export PATH="/h/Dev/Tools/node-24.22.1:$PATH"
cd repos/social-app
corepack pnpm@11.28.5 install
```

## 2. 流程

- 任何行为、接口、依赖、原生配置变更，先有 OpenSpec change 并通过用户审批。
- 先分析现有实现、调用方、测试与 Lexicon，再写提案。
- 先用 CodeGraph 定位；动态注册、字符串拼接、平台桥接等盲区必须用 `rg` 复核注册点，结论以 typecheck / 测试为准（见工作区根 `AGENTS.md` 第 4 节）。
- 小步实现；每步运行最小验证；不顺手重构。
- 涉及 atproto 契约时，先在 `repos/atproto` 确认 Lexicon 与 handler。

## 3. 代码位置与风格

- 新页面：`src/screens/<Name>/`；共享组件：`src/components/`；跨页面能力：`src/features/`。
- 不往 `src/view/` 新增文件；不新增顶层目录。
- 样式只用 ALF atoms / theme atoms；不硬编码颜色，不引入第二套样式系统。
- 新增文案使用 Lingui 宏；不运行 `intl:extract` / `intl:compile`（CI 负责）。
- 平台差异使用 `.ios.tsx` / `.android.tsx` / `.web.tsx`，不复制三份逻辑。
- TypeScript 版本以 `package.json` 锁文件为准；上游文档与依赖不一致时先向用户说明。

## 4. 安全

- 前端权限判断只影响展示，不能替代服务端授权。
- 不记录 token、密码、完整 DID 文档或私密内容。
- `EXPO_PUBLIC_*` 会进入客户端包，不得放密钥。
- 深度链接、上传、外部 URL 必须校验来源、类型与大小。
- 新增原生依赖前说明权限、隐私与商店合规影响。

## 5. 测试

```bash
corepack pnpm@11.28.5 test
corepack pnpm@11.28.5 typecheck
corepack pnpm@11.28.5 lint
```

- 行为变更必须有测试；覆盖失败路径与权限边界。
- 平台相关改动至少验证 Web + 一个原生平台的类型检查。
- 不 mock 真实 XRPC 契约来制造通过。
- E2E 仅在关键流程变更时运行，并记录设备/平台与命令。

## 6. 上游保持

- 不覆盖或重写上游 `AGENTS.md`；本文件是唯一叠加位置。
- 不批量格式化、不重命名上游目录、不升级无关依赖。
- 同步上游后重跑：`node scripts/apply-repo-overlays.mjs`、`npm run verify`、`npm run codegraph:sync`。
- 本地开发分支保持提交主题单一，便于 rebase。
