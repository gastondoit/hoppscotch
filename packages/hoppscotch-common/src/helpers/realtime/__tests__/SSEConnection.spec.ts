import { describe, expect, it, vi } from "vitest"
import { SSEConnection } from "~/helpers/realtime/SSEConnection"

function makeStream(chunks: string[]) {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe("SSEConnection", () => {
  it("parses events across chunks", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeStream([
          "event: greeting\r\ndata: hel",
          "lo\r\ndata: world\r\n\r\n",
        ]),
      } as any
    })

    vi.stubGlobal("fetch", fetchMock)

    const sse = new SSEConnection()
    const received: Array<{ event?: string; data: string }> = []

    sse.event$.subscribe((ev) => {
      if (ev.type === "MESSAGE_RECEIVED") {
        received.push({ event: ev.event, data: ev.data })
      }
    })

    await sse.start({
      method: "POST",
      effectiveFinalURL: "https://example.com/sse",
      effectiveFinalParams: [],
      effectiveFinalHeaders: [],
      effectiveFinalBody: null,
    } as any)

    expect(received).toEqual([{ event: "greeting", data: "hello\nworld" }])
  })

  it("appends query params to url", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeStream(["data: ok\n\n"]),
      } as any
    })

    vi.stubGlobal("fetch", fetchMock)

    const sse = new SSEConnection()

    await sse.start({
      method: "GET",
      effectiveFinalURL: "https://example.com/sse",
      effectiveFinalParams: [
        { active: true, key: "a", value: "1", description: "" },
        { active: true, key: "b", value: "2", description: "" },
      ],
      effectiveFinalHeaders: [],
      effectiveFinalBody: null,
    } as any)

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/sse?a=1&b=2",
      expect.anything()
    )
  })
})
