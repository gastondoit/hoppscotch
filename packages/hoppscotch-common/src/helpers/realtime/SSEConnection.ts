import { BehaviorSubject, Subject } from "rxjs"
import { platform } from "~/platform"
import type { EffectiveHoppRESTRequest } from "~/helpers/utils/EffectiveURL"

export type SSEEvent = { time: number } & (
  | { type: "STARTING" }
  | { type: "STARTED" }
  | {
      type: "MESSAGE_RECEIVED"
      event?: string
      data: string
      id?: string
      retry?: number
    }
  | { type: "STOPPED"; manual: boolean }
  | {
      type: "ERROR"
      error: {
        message: string
        status?: number
        statusText?: string
      }
    }
)

export type ConnectionState = "STARTING" | "STARTED" | "STOPPED"

export class SSEConnection {
  connectionState$: BehaviorSubject<ConnectionState>
  event$: Subject<SSEEvent> = new Subject()
  private abortController: AbortController | undefined

  constructor() {
    this.connectionState$ = new BehaviorSubject<ConnectionState>("STOPPED")
  }

  private addEvent(event: SSEEvent) {
    this.event$.next(event)
  }

  async start(request: EffectiveHoppRESTRequest) {
    this.connectionState$.next("STARTING")
    this.addEvent({
      time: Date.now(),
      type: "STARTING",
    })
    this.abortController?.abort()
    this.abortController = new AbortController()

    try {
      const url = this.applyParamsToURL(
        request.effectiveFinalURL,
        request.effectiveFinalParams
      )

      const headers = new Headers()
      let hasAcceptHeader = false

      for (const header of request.effectiveFinalHeaders) {
        if (!header.key) continue
        if (header.key.toLowerCase() === "accept") hasAcceptHeader = true
        headers.append(header.key, header.value)
      }

      if (!hasAcceptHeader) headers.set("Accept", "text/event-stream")

      const method = request.method.toUpperCase()
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : request.effectiveFinalBody ?? undefined

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: this.abortController.signal,
        credentials: "same-origin",
      })

      if (!response.ok) {
        this.handleError({
          message: "SSE request failed",
          status: response.status,
          statusText: response.statusText,
        })
        this.stopInternal(false)
        return
      }

      if (!response.body) {
        this.handleError({
          message: "SSE response body is not readable",
        })
        this.stopInternal(false)
        return
      }

      this.connectionState$.next("STARTED")
      this.addEvent({
        type: "STARTED",
        time: Date.now(),
      })

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        buffer = this.processBuffer(buffer)
      }

      buffer += decoder.decode()
      this.processBuffer(buffer)

      this.stopInternal(false)
    } catch (error) {
      if (this.abortController?.signal.aborted) return

      this.handleError({
        message: error instanceof Error ? error.message : "SSE request failed",
      })
      this.stopInternal(false)
    }

    platform?.analytics?.logEvent({
      type: "HOPP_REQUEST_RUN",
      platform: "sse",
    })
  }

  private processBuffer(buffer: string) {
    while (true) {
      const boundary = this.findEventBoundary(buffer)
      if (!boundary) break

      const rawEvent = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary.length)

      const parsed = this.parseEvent(rawEvent)
      if (!parsed) continue

      this.addEvent({
        type: "MESSAGE_RECEIVED",
        time: Date.now(),
        ...parsed,
      })
    }

    return buffer
  }

  private findEventBoundary(buffer: string) {
    const rn = buffer.indexOf("\r\n\r\n")
    const nn = buffer.indexOf("\n\n")

    if (rn === -1 && nn === -1) return null
    if (rn === -1) return { index: nn, length: 2 }
    if (nn === -1) return { index: rn, length: 4 }
    return rn < nn ? { index: rn, length: 4 } : { index: nn, length: 2 }
  }

  private parseEvent(rawEvent: string): {
    event?: string
    data: string
    id?: string
    retry?: number
  } | null {
    const lines = rawEvent.split(/\r?\n/)

    let eventName: string | undefined
    let id: string | undefined
    let retry: number | undefined
    const dataLines: string[] = []

    for (const line of lines) {
      if (!line) continue
      if (line.startsWith(":")) continue

      const colonIndex = line.indexOf(":")
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
      let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1)
      if (value.startsWith(" ")) value = value.slice(1)

      if (field === "event") {
        eventName = value
      } else if (field === "data") {
        dataLines.push(value)
      } else if (field === "id") {
        id = value
      } else if (field === "retry") {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) retry = parsed
      }
    }

    if (dataLines.length === 0) return null

    return {
      event: eventName || undefined,
      data: dataLines.join("\n"),
      id,
      retry,
    }
  }

  private applyParamsToURL(
    url: string,
    params: EffectiveHoppRESTRequest["effectiveFinalParams"]
  ) {
    const activeParams = params.filter((p) => p.active && p.key !== "")
    if (activeParams.length === 0) return url

    try {
      const parsed = new URL(url)
      for (const param of activeParams) {
        parsed.searchParams.append(param.key, param.value)
      }
      return parsed.toString()
    } catch (_e) {
      const qs = activeParams
        .map(
          (p) =>
            `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? "")}`
        )
        .join("&")

      if (!qs) return url
      return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`
    }
  }

  private handleError(error: { message: string; status?: number; statusText?: string }) {
    this.addEvent({
      time: Date.now(),
      type: "ERROR",
      error,
    })
  }

  stop() {
    this.stopInternal(true)
  }

  private stopInternal(manual: boolean) {
    if (this.connectionState$.value === "STOPPED") return

    this.abortController?.abort()
    this.connectionState$.next("STOPPED")
    this.addEvent({
      type: "STOPPED",
      time: Date.now(),
      manual,
    })
  }
}
