# dsh-429-guard

DeepSeek Harness（DSH）插件 —— **429 / 配额不足错误自动重试守卫**。

在 DSH Web UI 右上角挂一枚浮窗：未开启守卫时是一颗半透明小点，开启后换成同一位置的一枚盾牌，点一下展开卡片。开启后，模型请求遇到 429（含 `429 insufficient_quota`，官方归类为 `QUOTA`）会**自动退避重试**，默认无限次，直至成功、被逃生阀拦截，或你手动停止。

## 它解决什么问题

使用 DSH 时，模型 API 经常返回：

```
429: {"message":"Allocated quota exceeded, please increase your quota limit.","type":"invalid_request_error","code":"insufficient_quota"}
```

官方 `dsh-llm-retry` 在 `normal` 模式下达到 `maxRetries` 即放弃 → 抛出 `LlmError` → 当前 turn 中断，长任务半途而废。本插件在重试链中**接管官方放弃之后的 429 类错误**，继续退避重试（可被 agent 的 abort signal 取消）。

**第三方中转站同样覆盖**：不少 OpenAI 兼容网关（维云、各种 relay）把配额问题包成 HTTP 400/403，`status` 根本不是 429。判定除了 `code` / `status`，还保留一条**文案正则兜底**（`insufficient_quota`、`rate limit`、`quota exceeded`、`exceeded your current quota` …），中转站的错误也能认出来。正则**刻意不含裸「429」数字**（0.2.10 起）：错误文案里偶然出现的 429（无关日志、时间戳等）不会误判，数字型 429 由 `code` / `status` 兜住。

## 功能

- **两种形态、一个图标、一模一样的位置**：关闭 = 一颗 12px 小点（平时很淡，不挡视线不抢点击）；开启 = 同格里的盾牌圆钮（正在退避重试时变琥珀色并轻微呼吸）。两者都是 `26×26` 的格子、图标居中，所以**开关前后屏坐标完全不变**，不会左右跳。
- **可拖动、位置不记忆**：拖到任意位置；刷新后回到右上角（`top: 82px; right: 14px`）。拖动过程中不做任何自动让位——你放哪就是哪；落点回报（`client-report`）只在拖动结束时补一次，拖动途中不逐帧 POST。
- **首帧亮一下**：进页面后 2.4 秒内小点放大 + 一圈光晕，方便一眼找到它。
- **逃生阀**：「最多重试 N 次」「最长等待 N 秒」，留空即无限；达到上限则放弃该 step 的重试、交还控制权，任务按原流程失败，不会把请求挂死。
- **无持久化**：开关、设防、统计全是**进程内**状态，不写任何磁盘文件；重启即回到「关闭 + 无限」。每次重试与放弃都会写 DSH 主机端日志。
- **与官方 llm-retry 兼容共存**：waterfall 链中排在官方之后接管；provider 若配了 `always` 模式，官方自身已无限重试，本插件不被触发。
- **零构建步骤**：浏览器半是手写的 `ModuleLoader` bundle，改 `lib/client.js` 刷新页面即生效。
- **按需轮询**：卡片展开 2s、开启且收起 5s；守卫关闭且收起时**零轮询**；标签页隐藏（`document.hidden`）时暂停，回到前台立即补一次。

## 安装与重载

本插件是普通 npm 包形态的 Cordis 插件，装入哪个 profile 就作用于哪个 profile。

- **本地目录**：用 `plugin_manager` 的 `install_bundle`，`target` 传本仓库绝对路径。不要手写 profile 下的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 `pnpm`。
- **从 GitHub**：`dsh plugin --profile <当前激活的 profile 名> add github:moonqianqiu/dsh-429-guard`。
- **改动生效**：浏览器半（`lib/client.js`）刷新页面或重挂插件即可；主机半（`lib/index.js`）**不会热更新**，必须重挂插件（`plugin_manager` 里 disable → enable）或重启 DSH Web。
- 本机当前是软链接安装（`profiles/desktop/node_modules/dsh-429-guard` → 仓库目录），所以改完不用重装。

## 使用

1. 点右上角的图标展开卡片（卡片右上角 `×` 收起）。
2. 打开「自动重试」；需要保险丝就填「最多重试」或「最长等待」，留空 = 无限。
3. 卡片显示累计重试、逃生阀拦截、「最近拦截」时间与最近错误摘要；重试等待期间盾牌变琥珀色并呼吸，卡片显示「正在退避等待」。
4. 点「应用设防」保存上限（改设防会让已判过「放弃」的 step 重新有机会）；点「清零」重置统计。

## 架构

```
┌──────────────────────── DSH Web（浏览器） ────────────────────────┐
│  lib/client.js（shell.overlay 浮窗，React）                        │
│    ├─ 轮询 /guard-api/state（展开 2s · 收起 5s · 关+收起零轮询）   │
│    ├─ POST /guard-api/enable · /caps · /reset                     │
│    └─ POST /guard-api/client-report（落位/补量/拖动结束各报一次）  │
└──────────────────────────┬────────────────────────────────────────┘
                           │ 同源 fetch（仅 loopback 可信）
┌──────────────────────────▼────────────────────────────────────────┐
│  lib/index.js（主机端 cordis 插件，inject: ['webServer']）          │
│    ├─ ctx.on('agent/request-error', …) → 429 类重试 + 逃生阀        │
│    └─ ctx.webServer.register('/guard-api', …)                     │
└───────────────────────────────────────────────────────────────────┘
```

通信刻意走**极简同源路由**（`webServer.register`）而不是 `@Remote` 远程服务：不需要代码生成与构建流程，插件保持「手写 bundle、改完即生效」。

### 429 重试链路

```
模型请求 → 流式响应 → finish.kind === 'error'
  → dispatch.waterfall('agent/request-error', { failure, retryPolicy, signal, … }, fallback)
      ├─ dsh-llm-retry: normal 模式 previousRetry >= maxRetries → return next()（放弃）
      └─ dsh-429-guard:
            开关关闭 / 非 429 类   → return next()（放行，抛 LlmError，任务中断）
            逃生阀已触发          → return next()（放行，并记录「逃生阀拦截」）
            开关开启 + 429 类     → 退避等待（signal 可取消）→ return { kind: 'retry' }
                                   agent loop continue → 重新发起请求
```

`failure` 来自 `LlmError.failure`：`{ message, code, status?, providerRetryAfterMs?, requestId? }`（当前类型**没有** `cause` 字段，不要写遍历 `cause` 的兜底）。DeepSeek 的 `429 insufficient_quota` 经官方 `isQuotaExceededError` 归类为 `code = 'QUOTA'`。重试计数按 `${provider}:${turn}:${step}` 分组，同一 step 上累计 —— 这正是逃生阀的计数依据。

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/guard-api/state` | 开关 + 设防 + 统计 + 正在退避等待的条目 + 浏览器落点 |
| `POST` | `/guard-api/enable` | body `{ "enabled": true/false }`（仅内存） |
| `POST` | `/guard-api/caps` | body `{ "maxRetries": n\|null, "maxRetryMs": n\|null }` |
| `POST` | `/guard-api/reset` | 清零统计与 active 表 |
| `POST` | `/guard-api/client-report` | 浏览器回报落点，见下节 |

所有路由仅 loopback 可信（`127.0.0.1` / `::1`，且 Origin host 必须等于 Host 头），防远程 CSRF；请求体上限 64 KB。

## 退避策略

- 优先用 provider 的 `retry-after`（`failure.providerRetryAfterMs`），封顶 240s。
- 否则指数退避：`2s × 2^(retry-1)`，封顶 60s，抖动 ±25%。
- 等待期间监听 abort signal，用户手动停止立即放弃。

## 定位与遮挡（踩过的坑，别再踩）

- **别赌 `position: fixed` 的视口假设**：浮窗层里的条目挂在别的包含块中，祖先只要带 `transform` / `filter` / `perspective`，`fixed` 就改用那个盒子当参照系。现在先量出包含块原点再换算，写绝对 `left/top` 并清掉 `right/bottom`，最后按实测矩形兜底拽回视口内。
- **两种形态必须同格同中心**：只要形态宽度会变，任何「贴右边缘」的对齐都会在切换时横move几十像素。
- **落位用 `useLayoutEffect`**：坐标必须在绘制前写好，否则换形态会先按旧坐标画一帧。
- **宽度可能晚一帧才定型**：落位后下一帧再量一次（`settleFace`），只在宽度确实变了时按差值补一次。
- **被盖住就自己让位**：问浏览器「这个点上最上层的是谁」（`elementFromPoint`），不是自己人就按 22px 一步往下挪（最多 8 步）；同层还要比一遍小体积兄弟的矩形（`z-index` 比人家高时探针永远命中自己，判不出遮挡）。**拖动期间不做让位**，否则会和拖动写入的坐标打架，看着就是来回闪。
- 宿主必须 `width: max-content` + `pointer-events: auto`：浮窗层本身是点击穿透的，块级宿主会横贯整帧、挡住底下界面的点击。

## 诊断

拿不到 devtools 时，让浏览器自己说话：`GET /guard-api/state` 的 `client` 字段会带上最近一次回报的结果（落位时、落位后宽度补量时、拖动结束时各报一次）——

```json
"client": { "version": "0.2.10", "x": 1240, "y": 82, "w": 26, "h": 26,
            "usedW": 26, "vw": 1282, "vh": 822,
            "under": "div.an3WzG_tabs", "at": "…" }
```

- `x + w` 应等于 `vw - 14`；对不上说明落位没贴住角。
- `usedW` 与 `w` 不一致 = 又出现「宽度晚一帧定型」。
- `under` 是浮窗正下方最上层的元素（去掉自己后探到），用来确认到底压在谁身上。

## 开发自测

两个零依赖冒烟测试（桩替代 DSH 运行时与 React，不需要浏览器）：

```bash
node scripts/smoke.mjs         # 主机半：429 判定、逃生阀、abort、路由鉴权、浏览器回报（29 项断言）
node scripts/smoke-client.mjs  # 浏览器半：bundle 装载、slot 注册、形态同格居中、定位换算、遮挡让位、拖动不让位、宽度晚定型补量、轮询门控与拖动回报节流（87 项断言）
```

## License

MIT