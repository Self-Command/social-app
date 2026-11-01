# 插件框架

social-app 的内置插件系统。插件代码随应用包一起编译发布，服务端注册表只负责启用状态、能力授权与设置值，不下发也不执行远程代码。

## 交付模型

1. 插件位于 `src/features/plugins/catalog/<插件标识>/`，随应用构建进入安装包。
2. 应用读取 `EXPO_PUBLIC_PLUGIN_REGISTRY_URL` 指向的公开注册表，获得已启用插件、授权能力与设置值；未配置地址时不发起请求，插件槽位保持为空，应用照常运行。
3. 有效能力是清单声明与注册表授权的交集。清单声明的任一能力未被授权时，插件整体不渲染，不进入降级模式。
4. 注册表只能启用、配置已编译的插件，不能新增插件或代码。

## 目录结构

```text
src/features/plugins/
├── sdk/       清单类型、清单校验、设置合并、插槽与能力常量
├── runtime/   Provider、注册表客户端、账号隔离存储、错误边界、插槽渲染
├── host/      三个插槽的宿主组件，供发帖、帖子与设置页面接入
├── catalog/   内置插件，每个目录一个插件
│   ├── index.ts
│   └── com.selfcommand.bookmarks/
└── index.ts
```

`catalog/index.ts` 汇总全部内置插件为 `pluginCatalog`，`App.tsx` 通过 `PluginProvider` 挂载。

## 清单字段

清单文件为 `catalog/<插件标识>/manifest.json`，由插件入口调用 `parsePluginManifest` 校验后使用。字段不接受未声明的键。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `schemaVersion` | integer | 固定为 `1` |
| `id` | string | 反向域名格式，3 至 64 字符，必须与目录名一致 |
| `name` | string | 1 至 40 字符 |
| `description` | string | 1 至 200 字符 |
| `version` | string | 语义化版本，仅用于展示与排障 |
| `hostApi` | integer | 固定为 `1`；与宿主不一致的插件会被跳过 |
| `platforms` | string[] | `ios`、`android`、`web` 的非空子集 |
| `slots` | object[] | 非空，元素为 `{id, order}`；`id` 必须是已注册插槽，`order` 为 0 至 999 的整数 |
| `capabilities` | string[] | 已注册能力，不得重复 |
| `settings` | object[] | 类型化设置字段，见下文 |

插件入口必须同时导出与 `slots` 声明完全一致的插槽组件：声明了但未导出、导出了但未声明都会被构建期检查拒绝。

## 插槽

首期开放三个插槽。新增插槽或修改上下文属于宿主接口变更，必须提升 `hostApi` 并重新发布原生包。

| 插槽 | 位置 | 上下文 | 能力约束 |
| --- | --- | --- | --- |
| `composer.toolbar` | 发帖工具栏，与图片、相机、动图、表情同排 | `insertText(text)`、`getText()`、`closeComposer()` | 渲染入口不需要能力；调用 `insertText` 需要 `composer.insertText` |
| `feed.item.footer` | 单条帖子底部操作区之后 | `uri`、`cid`、`authorDid`、`authorHandle`、`authorDisplayName`、`text`、`createdAt` | 读取帖子上下文需要 `feed.read` |
| `settings.section` | 设置页分区列表 | 无额外上下文 | 无 |

同一插槽内按 `order` 升序渲染，`order` 相同时按插件标识字典序排列。宿主为每个插件实例包裹错误边界，单个插件异常不影响其余插件与其他界面。帖子底部的插件必须轻量，不得执行同步重计算或网络请求。

三个插槽的宿主组件分别是 `ComposerToolbarSlot`、`FeedItemFooterSlot` 与 `SettingsSectionSlot`，已分别接入发帖页、帖子列表与设置页。

## 能力

| 能力 | 提供给插件的对象 | 说明 |
| --- | --- | --- |
| `feed.read` | `context`（帖子公开字段） | 只读当前帖子的公开字段，不提供其他帖子或账号数据 |
| `composer.insertText` | `context.insertText` | 在光标处插入纯文本，不提供媒体、发送或清空正文能力 |
| `storage.local` | `host.storage`（`get`、`set`、`remove`、`list`、`clear`） | 按账号与插件隔离，容量受限 |
| `toast.show` | `host.toast.show` | 正式中文短提示，不提供弹窗或导航 |

未授权的能力对象不会传给插件，调用时不存在对应属性。

## 设置

设置只支持四种字段类型，默认值与类型约束必须同时满足；注册表提供的非法值会回退到清单默认值并记录不含具体值的问题项。

| 类型 | 默认值 | 可选约束 |
| --- | --- | --- |
| `string` | string | `minLength`、`maxLength` |
| `number` | finite number | `min`、`max` |
| `boolean` | boolean | 无 |
| `select` | string | `options`：非空且不重复的字符串数组，默认值必须属于其中 |

字段包含 `key`、`type`、`label`、`description`、`default`。`key` 为以字母开头的字母数字标识，不超过 64 字符，同一清单内不得重复；`label` 为 1 至 40 字符，`description` 为 1 至 200 字符。内置收藏插件使用 `maxItems`（number，默认 100，范围 10 至 500）。

## 注册表

配置项 `EXPO_PUBLIC_PLUGIN_REGISTRY_URL` 在构建期注入，可填写服务地址、以 `/xrpc` 结尾的基础地址或完整的公开端点；客户端统一补全为 `/xrpc/com.selfcommand.admin.plugin.public`。地址中不得包含账号、口令、查询串或片段。

客户端行为：

- 请求超时 3 秒，响应体上限 256 KB，最多接受 50 个插件。
- 使用 `ETag` 与 `If-None-Match` 协商，`304` 时继续使用缓存。
- 启动、应用回到前台与每 60 秒刷新一次。
- 响应结构非法或请求失败时回退到最近一次成功缓存；没有缓存时按“未启用任何插件”处理，不影响应用运行。

服务端接口约定、缓存头与限流规则见 `docs/development/plugin-framework.md`。

## 本地存储

`storage.local` 按“账号 DID + 插件标识”命名空间隔离。单个账号下的单个插件最多 256 KB、200 个键，只接受可 JSON 序列化的值。未登录时不提供存储对象，切换账号后读取各自的独立数据。

## 构建期检查

`scripts/plugins/check.mjs` 校验以下内容，任一不通过则命令失败并指出仓库内文件路径：

1. 清单文件存在、可解析且结构合法；插件标识唯一；未知插槽与能力被拒绝；设置定义合法。
2. 入口导出与清单声明的插槽完全一致。
3. 禁止网络与动态执行：`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`、`eval`、`Function` 构造、动态 `import()`、`require()`。
4. 导入白名单：`react`、`react-native`、`@lingui/core/macro`、`@lingui/react/macro`、`#/alf`、`#/components/Typography`；相对导入只允许指向插件目录或插件 SDK。
5. 文件大小上限：单个清单 16 KB，单个源码文件 64 KB，单个插件合计 256 KB。
6. `catalog/index.ts` 必须导入每个插件目录并在 `pluginCatalog` 中使用，且不得引用不存在的目录。

这些检查是工程约束，不是运行时沙箱。插件与宿主共享同一 JS 运行时，首期通过编译期内置、代码审查与可信发布控制风险；真正的第三方隔离由后续独立运行时方案解决。

## 新增插件

1. 在 `catalog/` 下以插件标识建立目录，编写 `manifest.json`。
2. 在目录内实现清单声明的全部插槽组件，入口解析清单并导出 `PluginDefinition`。
3. 在 `catalog/index.ts` 导入并加入 `pluginCatalog`。
4. 运行 `corepack pnpm@11.28.5 plugins:check`，并补充对应的 Jest 用例。
5. 在管理后台将该插件启用并授予清单声明的能力；未授权的插件不会渲染。

## 命令

以下命令在 `repos/social-app` 下执行，Node 版本不低于 24.22.1，包管理器使用 Corepack 固定的 pnpm 11.28.5。

```bash
corepack pnpm@11.28.5 plugins:check
corepack pnpm@11.28.5 plugins:check:test
corepack pnpm@11.28.5 --config.shell-emulator=true test -- src/features/plugins
corepack pnpm@11.28.5 typecheck:ios
corepack pnpm@11.28.5 typecheck:android
corepack pnpm@11.28.5 typecheck:web
```

- `plugins:check`：构建期插件检查，成功时输出插件与文件数量。
- `plugins:check:test`：检查脚本自身的 Node 测试，覆盖合法目录、重复标识、未知插槽、越界能力、非法设置、越权导入、违规网络调用、超大文件与未注册插件。
- `test -- src/features/plugins`：插件框架的 Jest 用例，包括 SDK、注册表客户端、存储、Provider、插槽宿主与收藏插件。
- `typecheck:ios`、`typecheck:android`、`typecheck:web`：分别对三个平台做全仓 TypeScript 检查。聚合脚本 `typecheck` 内部调用裸 `pnpm`，在仅通过 Corepack 使用 pnpm 的环境下无法运行，因此逐条执行。
