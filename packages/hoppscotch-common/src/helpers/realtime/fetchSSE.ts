export type SSEParsedEvent = {
  event: string
  data: string
  id?: string
  retry?: number
}

export type SSEParseCallbacks = {
  onEvent: (event: SSEParsedEvent) => void
}

export async function parseSSEFromReadableStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: SSEParseCallbacks,
  options?: {
    signal?: AbortSignal
  }
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8")

  let buffer = ""

  let currentEvent: string | undefined
  let currentId: string | undefined
  let currentRetry: number | undefined
  let dataLines: string[] = []

  const emit = () => {
    if (dataLines.length === 0) return

    callbacks.onEvent({
      event: currentEvent ?? "message",
      data: dataLines.join("\n"),
      id: currentId,
      retry: currentRetry,
    })

    currentEvent = undefined
    currentId = undefined
    currentRetry = undefined
    dataLines = []
  }

  while (true) {
    if (options?.signal?.aborted) {
      try {
        await reader.cancel()
      } catch (_e) {}
      return
    }

    const { value, done } = await reader.read()
    if (done) {
      emit()
      return
    }

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const nlIndex = buffer.indexOf("\n")
      if (nlIndex === -1) break

      let line = buffer.slice(0, nlIndex)
      buffer = buffer.slice(nlIndex + 1)

      if (line.endsWith("\r")) line = line.slice(0, -1)

      if (line === "") {
        emit()
        continue
      }

      if (line.startsWith(":")) continue

      const colonIndex = line.indexOf(":")
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
      let valuePart = colonIndex === -1 ? "" : line.slice(colonIndex + 1)
      if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1)

      if (field === "event") {
        currentEvent = valuePart
      } else if (field === "data") {
        dataLines.push(valuePart)
      } else if (field === "id") {
        currentId = valuePart
      } else if (field === "retry") {
        const n = Number(valuePart)
        if (!Number.isNaN(n)) currentRetry = n
      }
    }
  }
}
