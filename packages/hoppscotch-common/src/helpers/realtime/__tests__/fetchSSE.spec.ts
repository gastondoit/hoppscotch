import { describe, expect, it } from "vitest"
import { parseSSEFromReadableStream } from "../fetchSSE"

const enc = new TextEncoder()

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe("parseSSEFromReadableStream", () => {
  it("parses single data event", async () => {
    const events: any[] = []
    await parseSSEFromReadableStream(
      streamFromChunks(["data: hello\n\n"]),
      { onEvent: (e) => events.push(e) }
    )

    expect(events).toEqual([{ event: "message", data: "hello" }])
  })

  it("parses multi-line data event", async () => {
    const events: any[] = []
    await parseSSEFromReadableStream(
      streamFromChunks(["data: a\ndata: b\n\n"]),
      { onEvent: (e) => events.push(e) }
    )

    expect(events).toEqual([{ event: "message", data: "a\nb" }])
  })

  it("parses event type and id", async () => {
    const events: any[] = []
    await parseSSEFromReadableStream(
      streamFromChunks(["id: 1\nevent: foo\ndata: hi\n\n"]),
      { onEvent: (e) => events.push(e) }
    )

    expect(events).toEqual([{ event: "foo", data: "hi", id: "1" }])
  })

  it("handles chunk boundaries and CRLF", async () => {
    const events: any[] = []
    await parseSSEFromReadableStream(
      streamFromChunks(["data: hel", "lo\r\n\r\n"]),
      { onEvent: (e) => events.push(e) }
    )

    expect(events).toEqual([{ event: "message", data: "hello" }])
  })
})

