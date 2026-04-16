# 计划：HTTP/REST 页面新增 POST 请求的 SSE 实时响应支持

## Summary
- 目标：在现有 HTTP/REST 请求页面里，当发送 **POST** 请求且响应为 `text/event-stream`（SSE）时，支持在响应区域**实时显示**服务端推送的事件流内容，并允许用户随时取消。
- 主要实现思路：为浏览器直连拦截器（interceptor = `browser`）增加一条“Fetch + ReadableStream 解析 SSE”的执行路径，向现有 RxJS 响应流中持续推送“streaming”状态；UI 侧新增一个流式响应展示组件。

## Current State Analysis
### 项目结构（与本需求相关）
- 前端主逻辑在 [hoppscotch-common](file:///workspace/packages/hoppscotch-common)（Vue 3 + RxJS）。
- HTTP/REST 请求执行链路：
  - UI 发送入口在 [Request.vue](file:///workspace/packages/hoppscotch-common/src/components/http/Request.vue)：
    - 点击 Send 调用 [runRESTRequest$](file:///workspace/packages/hoppscotch-common/src/helpers/RequestRunner.ts#L449-L674) 得到 `Observable<HoppRESTResponse>`。
  - 网络执行在 [network.ts](file:///workspace/packages/hoppscotch-common/src/helpers/network.ts#L15-L80)：
    - 将 `EffectiveHoppRESTRequest` 转成 `RelayRequest` 后交给 [KernelInterceptorService](file:///workspace/packages/hoppscotch-common/src/services/kernel-interceptor.service.ts) 执行。
    - 返回结果一次性转换为 [HoppRESTResponse](file:///workspace/packages/hoppscotch-common/src/helpers/types/HoppRESTResponse.ts) 并 `complete()`。
- 现有实现无法实时渲染 SSE：
  - Web Relay 采用 axios，并设置 `responseType: "arraybuffer"`（见 kernel web relay 实现片段 [v/1.ts](file:///workspace/packages/hoppscotch-kernel/src/relay/impl/web/v/1.ts#L121-L137)），浏览器端无法在 axios 中可靠地按 chunk 读取响应体。
  - 当前 `RelayResponseBody` 设计为 `Uint8Array`（非流），且前端 `RESTResponse.toResponse` 假设响应体已完整到达（见 [rest/response.ts](file:///workspace/packages/hoppscotch-common/src/helpers/kernel/rest/response.ts#L72-L99)）。
- 响应 UI 目前只在 `!loading` 时渲染 body：
  - [Response.vue](file:///workspace/packages/hoppscotch-common/src/components/http/Response.vue) 使用 `loading = response.type === "loading" || testResults === null`，并在 `!loading && hasResponse` 时才展示 `LensesResponseBodyRenderer`。
  - 这会导致“流式响应期间”即使有内容也看不到。

### 与 SSE 相关的既有代码
- Realtime/SSE 页面使用 EventSource（GET-only）实现： [SSEConnection](file:///workspace/packages/hoppscotch-common/src/helpers/realtime/SSEConnection.ts#L14-L89)。
- 本需求选择的是 **HTTP/REST 请求页**（用户确认），因此不会复用 `EventSource` 这条 GET-only 通路。

## Proposed Changes
### 1) 扩展响应类型以表达“流式进行中”
**文件：**
- [HoppRESTResponse.ts](file:///workspace/packages/hoppscotch-common/src/helpers/types/HoppRESTResponse.ts)

**改动：**
- 新增 `HoppRESTStreamingResponse`（建议 `type: "streaming"`），至少包含：
  - `headers`, `statusCode`, `statusText`, `req`
  - `bodyText: string`（实时累积的可展示文本）
  - `meta: { responseSize?: number; responseDuration?: number }`（实时刷新/或仅完成时补全）
  - `streamKind: "sse"`（避免未来引入其他流协议时混淆）
- 同步修正当前代码里大量使用 `"fail"` 的实际情况（`RequestRunner.ts`、`ResponseMeta.vue`、`lenses.ts` 等均在判断 `response.type === "fail"`）：
  - 将类型定义中的 `type: "failure"` 调整为 `type: "fail"`（或直接移除未被使用的 `failure`，以与现有判断保持一致）。

**原因：**
- 需要一个“请求未结束，但已开始持续产出内容”的明确状态，来驱动 UI 在 loading 期间也能渲染流内容，同时保持 Send 按钮可取消。

### 2) 在网络层为 POST + browser interceptor 增加 Fetch SSE 流式执行通路
**文件：**
- [network.ts](file:///workspace/packages/hoppscotch-common/src/helpers/network.ts)
- 新增一个 SSE 解析/执行工具文件（建议）：
  - `src/helpers/realtime/fetchSSE.ts`（或 `src/helpers/network/sse.ts`，以项目现有命名为准）

**改动：**
- 在 `createRESTNetworkRequestStream(request)` 内增加分支：
  - 条件：
    - 当前拦截器为 `browser`（通过 `KernelInterceptorService.current.value?.id` 判断，id 已在 [browser interceptor](file:///workspace/packages/hoppscotch-common/src/platform/std/kernel-interceptors/browser/index.ts#L25-L37) 定义为 `"browser"`）
    - `request.method === "POST"`（严格符合本需求范围）
  - 行为：
    - 使用 `fetch(request.effectiveFinalURL, init)` 发起请求，其中：
      - headers：由 `request.effectiveFinalHeaders` 转换，并在不存在时自动补充 `Accept: text/event-stream`
      - body：使用 `request.effectiveFinalBody`（类型已在 [EffectiveURL.ts](file:///workspace/packages/hoppscotch-common/src/helpers/utils/EffectiveURL.ts#L33-L44) 定义为 `FormData | string | null | File | Blob`）
      - 使用 `AbortController` 支持取消
    - 当响应 headers 返回后：
      - 若 `content-type` 包含 `text/event-stream`，进入 SSE 流解析模式：
        - 立即 `next()` 一个 `type: "streaming"` 响应（包含 status/headers/bodyText=""）
        - 通过 `response.body.getReader()` 持续读取，使用 `TextDecoder`（`{ stream: true }`）进行增量解码
        - 实现 SSE frame 解析（处理 `event:`, `data:`, 空行分隔；`\r\n` 兼容）
        - 按“不过滤全部输出”（用户确认）策略，将每个 event 追加为可读文本（例如：`event=<type>\ndata=<payload>\n\n`），更新 `bodyText` 并持续 `next()` streaming 响应
        - 读取结束后，产出最终 `type: "success"` 响应，`body` 为 `TextEncoder().encode(bodyText).buffer`（保证后续下载/复制等能力不受影响）
      - 若不是 SSE：
        - 回退为“普通 fetch”一次性读取 `arrayBuffer()`，转换成现有 `type: "success"` 响应并 `complete()`
  - 其他拦截器（`agent/extension/proxy/desktop`）保持原有执行路径不变：
    - 这些路径目前返回的 `RelayResponseBody` 不是流，不具备 SSE 实时读取能力。

**安全/稳定性决策：**
- 为避免无限增长导致内存问题，对 `bodyText` 做截断（例如只保留最后 1MB 或最后 N 行）。实现上可在每次追加后执行截断。
- 当响应体为空/`response.body` 不可读时，发出 `network_fail` 或 `interceptor_error`（保持与现有错误模型一致）。

### 3) UI：在响应区域展示 SSE Streaming 内容，并保持取消能力
**文件：**
- [Request.vue](file:///workspace/packages/hoppscotch-common/src/components/http/Request.vue)
- [Response.vue](file:///workspace/packages/hoppscotch-common/src/components/http/Response.vue)
- [ResponseMeta.vue](file:///workspace/packages/hoppscotch-common/src/components/http/ResponseMeta.vue)
- 新增组件（建议）：
  - `src/components/http/SSEStream.vue`

**改动：**
- Request.vue：
  - `isTabResponseLoading` 需要把 `response.type === "streaming"` 视为“可取消进行中”，保证按钮显示为 Cancel。
- Response.vue：
  - `hasResponse` 增加 `streaming`
  - 当 `doc.response?.type === "streaming"` 时：
    - 即使 `loading === true` 也渲染流内容组件（例如 `SSEStream.vue`），而非等待 `testResults` 完成
    - 对于非 streaming 仍按原逻辑使用 `LensesResponseBodyRenderer`
- ResponseMeta.vue：
  - 当 `response.type === "streaming"` 时：
    - 不显示 loading spinner（或替换为“Streaming…”提示），同时仍显示 `statusCode/statusText`
    - 可选：显示已接收字节数/耗时（实时刷新或仅显示进行中）

### 4) 测试与回归
**文件：**
- 若新增 `fetchSSE.ts` 解析器，增加 `vitest` 单测：
  - `src/helpers/realtime/__tests__/fetchSSE.spec.ts`（或同目录风格）

**覆盖点：**
- SSE 分帧解析：
  - 单个 `data:`、多行 `data:` 合并
  - 同一个事件块里的 `event:` + `data:`
  - chunk 边界打断行/打断事件块的情况
  - `\r\n` 与 `\n` 兼容
- 截断策略生效（超过阈值时仍保持输出为最后一段）

## Assumptions & Decisions
- 范围锁定为：**HTTP/REST 请求页 + POST 请求 + 响应 content-type 为 `text/event-stream` 时实时展示**。
- 实时流式能力仅对当前拦截器为 `browser` 时启用；其他拦截器保持旧行为（一次性响应）。这是由底层 relay/response 类型不支持流式 body 的现实约束决定的。
- 事件展示策略：不按 eventType 过滤，全部输出（用户确认）。
- 流内容以文本形式累积，并做截断保护；完成后转换为最终 `success.body = ArrayBuffer` 以复用既有下载/复制能力。

## Verification Steps
- 单元测试：
  - `pnpm -C packages/hoppscotch-common test`
  - `pnpm -C packages/hoppscotch-common do-typecheck`
- 手动验证（开发模式）：
  - 启动 `pnpm -C packages/hoppscotch-common dev:vite`
  - 使用一个可 POST 并返回 `text/event-stream` 的服务（例如本地 mock：POST 后每秒推送一条 SSE data），在 HTTP/REST 页发送 POST：
    - 响应区应实时追加输出
    - Send 按钮应变为 Cancel，点击后应立即停止追加
    - 非 SSE 的 POST 请求行为不应变化（仍一次性显示完整响应）

