import { HoppRESTRequest } from "@hoppscotch/data"
import { Component } from "vue"
import { KernelInterceptorError } from "~/services/kernel-interceptor.service"

export type HoppRESTResponseHeader = { key: string; value: string }

export type HoppRESTSuccessResponse = {
  type: "success"
  headers: HoppRESTResponseHeader[]
  body: ArrayBuffer
  statusCode: number
  statusText: string
  meta: {
    responseSize: number // in bytes
    responseDuration: number // in millis
  }
  req: HoppRESTRequest
}

export type HoppRESTFailResponse = {
  type: "fail"
  headers: HoppRESTResponseHeader[]
  body: ArrayBuffer
  statusCode: number
  statusText: string
  meta: {
    responseSize: number // in bytes
    responseDuration: number // in millis
  }
  req: HoppRESTRequest
}

export type HoppRESTStreamingResponse = {
  type: "streaming"
  streamKind: "sse"
  headers: HoppRESTResponseHeader[]
  statusCode: number
  statusText: string
  bodyText: string
  meta: {
    responseSize?: number // in bytes
    responseDuration?: number // in millis
  }
  req: HoppRESTRequest
}

export type HoppRESTFailureNetwork = {
  type: "network_fail"
  error: unknown
  req: HoppRESTRequest
}

export type HoppRESTFailureScript = {
  type: "script_fail"
  error: Error
}

export type HoppRESTExtensionErrorResponse = {
  type: "extension_error"
  error: string
  component: Component
  req: HoppRESTRequest
}

export type HoppRESTInterceptorErrorResponse = {
  type: "interceptor_error"
  error: KernelInterceptorError
  req: HoppRESTRequest
}

export type HoppRESTLoadingResponse = {
  type: "loading"
  req: HoppRESTRequest
}

export type HoppRESTResponse =
  | HoppRESTLoadingResponse
  | HoppRESTStreamingResponse
  | HoppRESTSuccessResponse
  | HoppRESTFailResponse
  | HoppRESTFailureNetwork
  | HoppRESTFailureScript
  | HoppRESTExtensionErrorResponse
  | HoppRESTInterceptorErrorResponse
