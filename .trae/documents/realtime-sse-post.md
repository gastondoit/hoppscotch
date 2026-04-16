## 总结

在现有 Realtime → SSE 工具基础上，把“仅支持 GET(EventSource)”升级为“复用 REST 请求编辑器（URL/Method/Params/Headers/Auth/Body）并通过 fetch 流式读取 text/event-stream”，从而支持 POST 请求且可以持续接收并展示 SSE 流（展示全部事件）。

## 现状分析（基于仓库实测）

- 仓库形态：Hoppscotch monorepo，核心 Web UI 在 [packages/hoppscotch-common](file:///workspace/packages/hoppscotch-common)。
- 当前 SSE 工具入口页： [sse.vue](file:///workspace/packages/hoppscotch-common/src/pages/realtime/sse.vue)
  - 顶部仅有 URL + eventType 输入框，Start/Stop 按钮。
  - 使用 [SSEConnection](file:///workspace/packages/hoppscotch-common/src/helpers/realtime/SSEConnection.ts) 基于 EventSource 建立连接，因此只能 GET，且不能自定义 Headers/Body。
  - 状态/日志保存在 [SSESessionStore](file:///workspace/packages/hoppscotch-common/src/newstore/SSESession.ts)（仅 endpoint + eventType + log + socket）。
- 现有 REST 编辑器能力：
  - 默认 REST 请求结构： [getDefaultRESTRequest](file:///workspace/packages/hoppscotch-common/src/helpers/rest/default.ts)
  - 可复用的选项面板（Params/Body/Headers/Auth 等）： [RequestOptions.vue](file:///workspace/packages/hoppscotch-common/src/components/http/RequestOptions.vue)
  - 环境变量、Auth/Body 计算等： [EffectiveURL.ts](file:///workspace/packages/hoppscotch-common/src/helpers/utils/EffectiveURL.ts)（getEffectiveRESTRequest / getComputedHeaders / getFinalBodyFromRequest）
- 当前代码库里没有“用 fetch + ReadableStream 解析 SSE”的实现（搜索 getReader/ReadableStream/text/event-stream 未找到），因此需要新增解析与连接实现。

## 目标与成功标准

- 在 Realtime → SSE 页面支持 POST（以及其它方法也应可用），并能持续接收 SSE 响应流。
- 页面侧使用“复用 REST 编辑器”的交互方式：
  - URL（支持环境变量输入体验保持一致）
  - Method（GET/POST/…）
  - Params/Headers/Auth/Body（使用现有 HttpRequestOptions 组件体系）
- 日志展示“全部事件”（不再按 eventType 过滤）；每条日志带上事件名（若无 event 字段则使用 message）。
- Start/Stop 行为稳定：
  - Start：建立连接、清空或追加日志（与现有行为保持一致）
  - Stop：能主动中断 fetch（AbortController）
  - 错误：网络错误/非 2xx/无 body stream 等情况下能落日志并进入 STOPPED 状态

## 方案概述

用 fetch 发起请求并读取 response.body 的字节流，在浏览器侧解析 Server-Sent Events 协议（以空行分隔 event，解析 event/data/id/retry 等字段）。这样即可支持 POST + 自定义 headers/body，同时也能覆盖 GET。

说明：这条链路走浏览器 fetch（非 KernelInterceptorService/代理/扩展/桌面 Agent 拦截器），因此仍受 CORS 影响；这与现有 EventSource 的限制一致，且符合 Realtime 工具定位。

## 具体改动（文件级）

### 1) 重构 SSESession：从“endpoint/eventType”升级为“REST 请求对象 + 选项面板状态”

目标：让 Realtime SSE 页面能直接绑定到 HoppRESTRequest，并复用 HttpRequestOptions。

- 更新 [SSESession.ts](file:///workspace/packages/hoppscotch-common/src/newstore/SSESession.ts)
  - 将 HoppSSERequest 从 `{ endpoint, eventType }` 改为 `HoppRESTRequest`（或包含一个 `request: HoppRESTRequest` 字段）
  - 增加 `optionTabPreference`（类型复用 RequestOptions.vue 中的 RESTOptionTabs）用于记忆当前选项卡
  - 保留 log、socket（但 socket 类型会升级为新的 fetch 连接类）
  - 提供新的 setX dispatchers：
    - setSSERequest / setSSERequestEndpoint / setSSERequestMethod / setSSERequestOptionTab 等（按现有 store 风格拆分）

决策：不复用 RESTTabService/HoppTab 体系，避免引入“保存/历史/脚本/测试”等 REST 页面强绑定逻辑；只复用请求数据结构与选项面板组件。

### 2) 新增/改造 SSEConnection：用 fetch 流式解析 SSE（支持 POST）

- 更新 [SSEConnection.ts](file:///workspace/packages/hoppscotch-common/src/helpers/realtime/SSEConnection.ts)
  - 替换 EventSource 实现为 fetch + AbortController：
    - `start(effectiveRequest: EffectiveHoppRESTRequest)` 或 `start(request: HoppRESTRequest, env: Environment)`
    - 内部创建 `AbortController`，请求时带上 signal
    - 自动补齐 `Accept: text/event-stream`（当用户未显式设置时）
    - 将 `effectiveFinalHeaders` 转为 fetch Headers；body 使用 `effectiveFinalBody`
  - 解析 SSE：
    - 按空行（\n\n 或 \r\n\r\n）切分事件块
    - 事件块内解析：
      - `event:` → eventName
      - `data:` 多行拼接（以 \n 连接）
      - `id:`、`retry:` 记录在事件对象上（可选）
      - `:` comment 行忽略
    - 每解析到一个完整事件即 emit 到 `event$`
  - 扩展 SSEEvent 类型：
    - `MESSAGE_RECEIVED` 增加 `{ event?: string; data: string; id?: string; retry?: number }`（或保持 message 字段但把 prefix 拼进去）
    - `STOPPED` 增加 `manual: boolean`（现有已有）并在异常终止时 manual=false
  - stop()：
    - `abortController.abort()` 并进入 STOPPED

边界与失败模式：
- response.ok 为 false：发出 ERROR（包含 status/statusText）并 STOPPED
- response.body 为空：发出 ERROR 并 STOPPED
- TextDecoder 流式解码：处理 chunk 边界切割，保留 buffer
- 连接断开（reader done）：进入 STOPPED(manual=false)

### 3) 改造 Realtime SSE 页面：复用 REST 编辑器 + 新连接逻辑

- 更新 [sse.vue](file:///workspace/packages/hoppscotch-common/src/pages/realtime/sse.vue)
  - 顶部输入区从（URL + eventType）改为：
    - Method 选择（沿用 REST 页的 method selector 交互风格）
    - URL 输入（继续使用 SmartEnvInput + RegexWorker 校验）
    - Start/Stop 按钮逻辑保持不变（STOPPED → start，否则 stop）
  - 新增请求选项区（tabs）：
    - 引入 HttpRequestOptions，并限制 properties 为：params/bodyParams/headers/authorization
    - 绑定 SSESession store 中的 request 与 optionTabPreference
  - Start 时：
    - 从 store 取 request
    - 组合环境变量（沿用 REST RequestRunner 的环境合并策略，最小实现可用 getCombinedEnvVariables 的 global+selected）
    - 调用 getEffectiveRESTRequest 产出 EffectiveHoppRESTRequest
    - 传给 SSEConnection.start
  - 日志展示改为“全部事件”：
    - MESSAGE_RECEIVED：写入 log，prefix 为 `[${eventName}]`（若无 eventName 则 `[message]`），payload 为 data（保持原样）

### 4) 增加自动化测试（建议）

为 SSE 解析器添加单元测试，避免回归：

- 新增测试文件（位置按现有 vitest 习惯放在 src/helpers/realtime/__tests__/）：
  - 覆盖：
    - 单事件单 data
    - 多 data 行拼接
    - chunk 边界切割（事件跨 chunk）
    - event/id/retry 解析
    - 忽略 comment 行

## 假设与已确认决策

- 范围：仅实现 Realtime/SSE 页面（不改普通 HTTP 请求页）。
- UI：复用 REST 编辑器（RequestOptions：Params/Body/Headers/Auth），不引入 REST Tab/保存/历史/脚本/测试等复杂能力。
- 展示：输出全部 SSE 事件（不按 eventType 过滤）。
- 网络路径：使用浏览器 fetch 直连（仍受 CORS/同源策略限制）。

## 验证步骤（执行阶段）

- 运行类型检查与单测（以仓库脚本为准）：
  - 在 common 包运行 vitest/类型检查
- 手工验证：
  - GET SSE：对公开 SSE endpoint 能持续输出日志
  - POST SSE：对可用的 POST SSE 服务（或本地 mock）能持续输出日志
  - Stop：点击 Stop 后应立即断流并进入 STOPPED
  - 错误处理：无效 URL、非 2xx、无 body stream 时应输出错误并停止

