import * as TE from "fp-ts/TaskEither"
import { BehaviorSubject, Observable } from "rxjs"
import { cloneDeep } from "lodash-es"
import { HoppRESTResponse } from "./types/HoppRESTResponse"
import { EffectiveHoppRESTRequest } from "./utils/EffectiveURL"
import { getService } from "~/modules/dioc"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { RESTRequest, RESTResponse } from "~/helpers/kernel/rest"
import { RelayError } from "@hoppscotch/kernel"
import { parseSSEFromReadableStream } from "./realtime/fetchSSE"

export type NetworkStrategy = (
  req: EffectiveHoppRESTRequest
) => TE.TaskEither<RelayError, HoppRESTResponse>

export function createRESTNetworkRequestStream(
  request: EffectiveHoppRESTRequest
): [Observable<HoppRESTResponse>, () => void] {
  const response = new BehaviorSubject<HoppRESTResponse>({
    type: "loading",
    req: request,
  })

  const req = cloneDeep(request)
  const service = getService(KernelInterceptorService)

  const abortController = new AbortController()

  const shouldTryStreamingFetch =
    service.current.value?.id === "browser" && req.method.toUpperCase() === "POST"

  if (shouldTryStreamingFetch) {
    executeFetchRequestWithSSEFallback(req, response, abortController).finally(
      () => {
        response.complete()
      }
    )

    return [
      response,
      async () => {
        abortController.abort()
      },
    ]
  }

  const execResult = RESTRequest.toRequest(req).then((kernelRequest) => {
    if (!kernelRequest) {
      response.next({
        type: "network_fail",
        req,
        error: new Error("Failed to create kernel request"),
      })
      response.complete()
      return
    }

    return service.execute(kernelRequest)
  })

  execResult.then((result) => {
    if (!result) return

    result.response.then(async (res) => {
      if (res._tag === "Right") {
        const processedRes = await RESTResponse.toResponse(res.right, req)

        if (processedRes.type === "success") {
          response.next(processedRes)
        } else {
          response.next({
            type: "network_fail",
            req,
            error: processedRes.error,
          })
        }
      } else {
        response.next({
          type: "interceptor_error",
          req,
          error: res.left,
        })
      }
      response.complete()
    })
  })

  return [
    response,
    async () => {
      try {
        const result = await execResult
        if (result) await result.cancel()
      } catch (_error) {
        // Ignore cancel errors - request may have already completed
        // This is expected behavior and not an actual error
      }
    },
  ]
}

async function executeFetchRequestWithSSEFallback(
  req: EffectiveHoppRESTRequest,
  subject: BehaviorSubject<HoppRESTResponse>,
  abortController: AbortController
) {
  const startedAt = Date.now()

  try {
    const headers = new Headers()
    for (const h of req.effectiveFinalHeaders) {
      if (h.active) headers.set(h.key, h.value)
    }

    if (![...headers.keys()].some((k) => k.toLowerCase() === "accept")) {
      headers.set("Accept", "text/event-stream")
    }

    const body = req.effectiveFinalBody ?? undefined
    if (body instanceof FormData) {
      for (const k of [...headers.keys()]) {
        if (k.toLowerCase() === "content-type") headers.delete(k)
      }
    }

    const res = await fetch(req.effectiveFinalURL, {
      method: "POST",
      headers,
      body,
      signal: abortController.signal,
    })

    const responseHeaders = Array.from(res.headers.entries()).map(
      ([key, value]) => ({ key, value })
    )

    const contentType = res.headers.get("content-type") ?? ""

    if (/\btext\/event-stream\b/i.test(contentType) && res.body) {
      const encoder = new TextEncoder()
      const maxBytes = 1_000_000
      let bodyText = ""

      subject.next({
        type: "streaming",
        streamKind: "sse",
        headers: responseHeaders,
        statusCode: res.status,
        statusText: res.statusText,
        bodyText,
        meta: {
          responseDuration: Date.now() - startedAt,
          responseSize: 0,
        },
        req,
      })

      await parseSSEFromReadableStream(
        res.body,
        {
          onEvent: (event) => {
            let fragment = ""

            if (event.id) fragment += `id: ${event.id}\n`
            if (event.event && event.event !== "message") {
              fragment += `event: ${event.event}\n`
            }

            const dataLines = event.data.split("\n")
            fragment += dataLines.map((l) => `data: ${l}`).join("\n")
            fragment += "\n\n"

            bodyText += fragment

            const bytes = encoder.encode(bodyText)
            if (bytes.byteLength > maxBytes) {
              const trimmed = bytes.slice(bytes.byteLength - maxBytes)
              bodyText = new TextDecoder("utf-8").decode(trimmed)
            }

            subject.next({
              type: "streaming",
              streamKind: "sse",
              headers: responseHeaders,
              statusCode: res.status,
              statusText: res.statusText,
              bodyText,
              meta: {
                responseDuration: Date.now() - startedAt,
                responseSize: encoder.encode(bodyText).byteLength,
              },
              req,
            })
          },
        },
        {
          signal: abortController.signal,
        }
      )

      if (abortController.signal.aborted) return

      const finalBytes = encoder.encode(bodyText)

      subject.next({
        type: "success",
        headers: responseHeaders,
        body: finalBytes.buffer,
        statusCode: res.status,
        statusText: res.statusText,
        meta: {
          responseDuration: Date.now() - startedAt,
          responseSize: finalBytes.byteLength,
        },
        req,
      })

      return
    }

    const buf = await res.arrayBuffer()
    subject.next({
      type: "success",
      headers: responseHeaders,
      body: buf,
      statusCode: res.status,
      statusText: res.statusText,
      meta: {
        responseDuration: Date.now() - startedAt,
        responseSize: buf.byteLength,
      },
      req,
    })
  } catch (error) {
    if (
      abortController.signal.aborted ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError")
    ) {
      return
    }

    subject.next({
      type: "network_fail",
      req,
      error,
    })
  }
}
