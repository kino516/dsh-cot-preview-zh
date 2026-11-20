# dsh-cot-preview-zh

给 **折叠状态的思考预览行** 加中文翻译的 DSH（DeepSeek Harness）插件。

> A DeepSeek Harness (DSH) plugin that translates the **collapsed reasoning preview line** in the chat transcript.
> The official `cot-translation` bundle only translates the *expanded* reasoning body; the collapsed one-line
> summary is rendered inline by `ReasoningRow` and exposes no slot. This plugin fills that gap in the display
> layer, reusing the official Host-side translator (browser calls to Bing/Google are blocked by CORS).

## 它解决什么

插件管两处，做法完全不同：

**1. 折叠的思考预览行 —— 机器翻译**

官方 `@deepseek-ai/dsh-experimental-client-ui-cot-translation` 只翻「**展开后**的思考正文」。折叠时那行预览是 `dsh-client-ui-chat` 里 `ReasoningRow` 用
`firstLine(reasoning)` / `latestCompletedParagraphFirstLine(reasoning)` 就地拼出来直接渲染的，**没有暴露任何 Slot**，所以官方插件改不到它。

**2. 工具折叠行 —— 只换工具名标签，不动机翻**

DSH 对**未登记的工具**会把 wire 名拼进摘要（`dsh-client-ui-tool` 的 `tool-call-model.ts`：
`summary = [titleKey === 'tool.title.generic' ? toolName : '', base].join(' · ')`），
于是行里出现 `工具 · ops_bash · ls -la /d/Deepseek` 这种全英文。

这里**不做机器翻译**：那一行是标识符 + 命令/路径，翻它会破坏可复制性、甚至让命令失真。
插件只把工具名前缀换成中文标签，参数原样保留：

```
工具 · ops_bash · ls -la /d/Deepseek     →  执行命令 · ls -la /d/Deepseek
工具 · dsh_browser_screenshot · ...      →  浏览器·截图 · ...
工具 · skill · dsh-doc                   →  加载技能 · dsh-doc
工具 · bash · 列出目录                   →  工具 · bash · 列出目录   （已知工具本就有中文标题，不动）
```

映射表在 `client.js` 顶部（`TOOL_LABELS` / `BROWSER_LABELS`），按 `dsh_browser_*` 动词族做了兜底；
没有映射的未知工具**保持原样**，不猜。

本插件在展示层补这一层：

```
折叠思考行 [data-variant="think"][data-preview]
  ├─ span[data-shimmer-decoration]   ← 装饰分隔符（结构锚点）
  └─ span                            ← 预览容器
       ├─ span                       ← 原文节点（插件给它加 data-cot-preview-zh-hidden 隐藏）
       └─ span                       ← 插件插入的译文节点（复用原文类名，排版一致）
```

翻译请求走官方 `translator` 的 Host 端（`ctx.remote.cotTranslation`）——浏览器直连 Bing 会被 CORS 挡住，必须由 Host 发。

## 组成

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 插入 `translator`、`cot-translation`（Bing + 跟随界面语言）和本插件三行 |
| `index.js` | 宿主半边，空实现 |
| `client.js` | 客户端半边：观察折叠思考行 → 取预览文本 → 请求翻译 → 替换显示 |

`translator` / `cot-translation` 是**随 dsh 发布的包**，按官方插件规范从安装目录解析，所以本包不声明任何依赖。

## 行为

- 只处理非展开、确实在显示预览的思考行（`[data-variant="think"][data-preview]`）。
- 工具行只改工具名前缀：找不到对应映射、或该工具本就有中文标题时不碰 DOM。
- 已经是中文的预览不送翻译请求。
- 流式思考等文本稳定 700ms 再翻；同文本命中缓存或在途请求不重复发。
- 失败保留英文原文，同一段文本 5 分钟内不重试。
- 一行进入视口才翻译（`IntersectionObserver`），不会为整段历史一次性发请求。
- 卸载时断开观察、取消定时器、还原所有被改写的预览。

## 踩坑记录（DSH 客户端插件）

1. **服务注入按属性名白名单**：`inject: ['remote']` 只允许访问 `ctx.remote` 本身，访问 `ctx.remote.cotTranslation` 会抛
   `cannot get property "remote.cotTranslation" without inject`。父子两级都要声明：
   `inject: ['slots', 'remote', 'remote.cotTranslation', 'locale']`（官方插件是外层 `inject: ['remote', ...]` + 内层 `ctx.inject(['remote.cotTranslation', ...])`）。
2. **`inject` 不满足时插件不会 apply**，表现为「完全没反应」；包一层 try/catch 会把 guard 报错吞成 `undefined`，更难查。
3. **渲染进程 console 转发**：DSH NEXT 只把 **error 级别**的渲染日志转发到 `~/.dsh/logs/desktop-next.log`，
   `info`/`debug` 不转发。所以本插件只在失败时打 `console.error` 诊断，健康时不产生日志。
4. **客户端 bundle 带内容哈希**（`...client.js&rev=<hash>`），改完 `client.js` 用 `Ctrl+R` 刷新窗口即可拉取新版，不必整重启。

## 已知限制

- **DOM 层补丁**：DSH 升级若改了思考行的结构（分隔符节点或预览容器层级），需要跟着改 `queryParts()`。
- 译文会发送给所选翻译服务（默认 Bing），与官方展开翻译同一条通路。
- 折叠预览与展开正文是两段不同文本，各自计费/请求；都命中 Host 侧缓存。

## 安装

```bash
git clone https://github.com/kino516/dsh-cot-preview-zh.git
```

然后在 DSH 里 **插件页 → 添加插件 → 选择这个目录**（或以绝对目录作为 target 调用 `plugin_manager install_bundle`）。
安装后重启 DSH，再刷新窗口。

依赖：DSH 自带（`0.2.2-rc.5` 起）的 `@deepseek-ai/dsh-experimental-translator` 与
`@deepseek-ai/dsh-experimental-client-ui-cot-translation` —— 本插件通过 `cordis.patch.yml` 把这两行和插件自己一起插入，
所以**不需要**单独安装官方的 `cot-translation` bundle。这两个包随 dsh 发布，从安装目录解析，因此本包不声明任何 dependencies。
