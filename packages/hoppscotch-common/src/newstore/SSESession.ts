import { pluck, distinctUntilChanged } from "rxjs/operators"
import DispatchingStore, { defineDispatchers } from "./DispatchingStore"
import {
  HoppRealtimeLog,
  HoppRealtimeLogLine,
} from "~/helpers/types/HoppRealtimeLog"
import { SSEConnection } from "~/helpers/realtime/SSEConnection"
import { HoppRESTRequest } from "@hoppscotch/data"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import type { RESTOptionTabs } from "~/components/http/RequestOptions.vue"

type HoppSSESession = {
  request: HoppRESTRequest
  optionTabPreference: RESTOptionTabs
  log: HoppRealtimeLog
  socket: SSEConnection
}

const defaultSSERequest: HoppRESTRequest = {
  ...getDefaultRESTRequest(),
  endpoint: "https://express-eventsource.herokuapp.com/events",
  name: "SSE",
}

const defaultSSESession: HoppSSESession = {
  request: defaultSSERequest,
  optionTabPreference: "params",
  socket: new SSEConnection(),
  log: [],
}

const dispatchers = defineDispatchers({
  setRequest(
    _: HoppSSESession,
    { newRequest }: { newRequest: HoppRESTRequest }
  ) {
    return {
      request: newRequest,
    }
  },
  setEndpoint(curr: HoppSSESession, { newEndpoint }: { newEndpoint: string }) {
    return {
      request: {
        ...curr.request,
        endpoint: newEndpoint,
      },
    }
  },
  setMethod(curr: HoppSSESession, { newMethod }: { newMethod: string }) {
    return {
      request: {
        ...curr.request,
        method: newMethod,
      },
    }
  },
  setOptionTab(
    _: HoppSSESession,
    { optionTab }: { optionTab: RESTOptionTabs }
  ) {
    return {
      optionTabPreference: optionTab,
    }
  },
  setSocket(_: HoppSSESession, { socket }: { socket: SSEConnection }) {
    return {
      socket,
    }
  },
  setLog(_: HoppSSESession, { log }: { log: HoppRealtimeLog }) {
    return {
      log,
    }
  },
  addLogLine(curr: HoppSSESession, { line }: { line: HoppRealtimeLogLine }) {
    return {
      log: [...curr.log, line],
    }
  },
})

const SSESessionStore = new DispatchingStore(defaultSSESession, dispatchers)

export function setSSERequest(newRequest?: HoppRESTRequest) {
  SSESessionStore.dispatch({
    dispatcher: "setRequest",
    payload: {
      newRequest: newRequest ?? defaultSSERequest,
    },
  })
}

export function setSSEEndpoint(newEndpoint: string) {
  SSESessionStore.dispatch({
    dispatcher: "setEndpoint",
    payload: {
      newEndpoint,
    },
  })
}

export function setSSEMethod(newMethod: string) {
  SSESessionStore.dispatch({
    dispatcher: "setMethod",
    payload: {
      newMethod,
    },
  })
}

export function setSSEOptionTab(optionTab: RESTOptionTabs) {
  SSESessionStore.dispatch({
    dispatcher: "setOptionTab",
    payload: {
      optionTab,
    },
  })
}

export function setSSESocket(socket: SSEConnection) {
  SSESessionStore.dispatch({
    dispatcher: "setSocket",
    payload: {
      socket,
    },
  })
}

export function setSSELog(log: HoppRealtimeLog) {
  SSESessionStore.dispatch({
    dispatcher: "setLog",
    payload: {
      log,
    },
  })
}

export function addSSELogLine(line: HoppRealtimeLogLine) {
  SSESessionStore.dispatch({
    dispatcher: "addLogLine",
    payload: {
      line,
    },
  })
}

export const SSERequest$ = SSESessionStore.subject$.pipe(
  pluck("request"),
  distinctUntilChanged()
)

export const SSEEndpoint$ = SSESessionStore.subject$.pipe(
  pluck("request", "endpoint"),
  distinctUntilChanged()
)

export const SSEMethod$ = SSESessionStore.subject$.pipe(
  pluck("request", "method"),
  distinctUntilChanged()
)

export const SSEOptionTab$ = SSESessionStore.subject$.pipe(
  pluck("optionTabPreference"),
  distinctUntilChanged()
)

export const SSESocket$ = SSESessionStore.subject$.pipe(
  pluck("socket"),
  distinctUntilChanged()
)

export const SSELog$ = SSESessionStore.subject$.pipe(
  pluck("log"),
  distinctUntilChanged()
)
