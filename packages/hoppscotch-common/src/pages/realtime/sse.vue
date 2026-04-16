<template>
  <AppPaneLayout layout-id="sse">
    <template #primary>
      <div class="flex flex-1 flex-col">
        <div
          class="sticky top-0 z-10 flex flex-shrink-0 space-x-2 overflow-x-auto bg-primary p-4"
        >
          <div class="flex flex-1 whitespace-nowrap rounded border border-divider">
            <div class="relative flex">
              <label for="method">
                <tippy
                  interactive
                  trigger="click"
                  theme="popover"
                  :on-shown="() => methodTippyActions.focus()"
                >
                  <HoppSmartSelectWrapper>
                    <input
                      id="method"
                      class="flex w-26 cursor-pointer rounded-l bg-primaryLight px-4 py-2 font-semibold text-secondaryDark transition"
                      :value="request.method"
                      :readonly="request.method !== 'CUSTOM'"
                      :placeholder="`${t('request.method')}`"
                      :style="{
                        color: getMethodLabelColor(request.method),
                      }"
                      :disabled="
                        connectionState === 'STARTED' ||
                        connectionState === 'STARTING'
                      "
                      @input="onSelectMethod($event)"
                    />
                  </HoppSmartSelectWrapper>
                  <template #content="{ hide }">
                    <div
                      ref="methodTippyActions"
                      class="flex flex-col focus:outline-none"
                      tabindex="0"
                      @keyup.escape="hide()"
                    >
                      <HoppSmartItem
                        v-for="(method, index) in methods"
                        :key="`method-${index}`"
                        :label="method"
                        :style="{
                          color: getMethodLabelColor(method),
                        }"
                        @click="
                          () => {
                            updateMethod(method)
                            hide()
                          }
                        "
                      />
                    </div>
                  </template>
                </tippy>
              </label>
            </div>
            <div
              class="flex flex-1 whitespace-nowrap rounded-r border-l border-divider bg-primaryLight transition"
              :class="{ error: !isUrlValid }"
            >
              <SmartEnvInput
                v-model="request.endpoint"
                :placeholder="t('sse.url')"
                :auto-complete-env="true"
                :envs="envs"
                :readonly="
                  connectionState === 'STARTED' ||
                  connectionState === 'STARTING'
                "
                @enter="isUrlValid ? toggleSSEConnection() : null"
              />
            </div>
          </div>
          <HoppButtonPrimary
            id="start"
            :disabled="!isUrlValid"
            name="start"
            class="sm:w-32 w-full"
            :label="
              connectionState === 'STARTING'
                ? t('action.starting')
                : connectionState === 'STOPPED'
                  ? t('action.start')
                  : t('action.stop')
            "
            :loading="connectionState === 'STARTING'"
            @click="toggleSSEConnection"
          />
        </div>

        <HttpRequestOptions
          v-model="request"
          v-model:option-tab="optionTabPreference"
          :properties="['params', 'bodyParams', 'headers', 'authorization']"
          :envs="envs"
        />
      </div>
    </template>
    <template #secondary>
      <RealtimeLog
        :title="t('sse.log')"
        :log="log as LogEntryData[]"
        @delete="clearLogEntries()"
      />
    </template>
  </AppPaneLayout>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, onMounted, computed } from "vue"
import "splitpanes/dist/splitpanes.css"
import { debounce } from "lodash-es"
import {
  SSERequest$,
  setSSERequest,
  SSEOptionTab$,
  setSSEOptionTab,
  SSESocket$,
  setSSESocket,
  SSELog$,
  setSSELog,
  addSSELogLine,
} from "~/newstore/SSESession"
import { useToast } from "@composables/toast"
import { useI18n } from "@composables/i18n"
import {
  useStream,
  useStreamSubscriber,
  useReadonlyStream,
} from "@composables/stream"
import { SSEConnection } from "@helpers/realtime/SSEConnection"
import RegexWorker from "@workers/regex?worker"
import { LogEntryData } from "~/components/realtime/Log.vue"
import { getMethodLabelColor } from "~/helpers/rest/labelColoring"
import { aggregateEnvsWithCurrentValue$ } from "~/newstore/environments"
import { getEffectiveRESTRequest } from "~/helpers/utils/EffectiveURL"
import { Environment } from "@hoppscotch/data"
import { getDefaultRESTRequest } from "~/helpers/rest/default"

const t = useI18n()
const toast = useToast()
const { subscribeToStream } = useStreamSubscriber()

const sse = useStream(SSESocket$, new SSEConnection(), setSSESocket)
const connectionState = useReadonlyStream(sse.value.connectionState$, "STOPPED")
const defaultRequest = {
  ...getDefaultRESTRequest(),
  endpoint: "https://express-eventsource.herokuapp.com/events",
  name: "SSE",
}
const request = useStream(SSERequest$, defaultRequest, setSSERequest)
const optionTabPreference = useStream(SSEOptionTab$, "params", setSSEOptionTab)
const log = useStream(SSELog$, [], setSSELog)
const envs = useReadonlyStream(aggregateEnvsWithCurrentValue$, [])

const isUrlValid = ref(true)

const methods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "CUSTOM",
]

const methodTippyActions = ref<any | null>(null)

let worker: Worker

const endpoint = computed(() => request.value.endpoint)

const debouncer = debounce(function () {
  worker.postMessage({ type: "sse", url: endpoint.value })
}, 1000)

watch(endpoint, (url) => {
  if (url) debouncer()
})

const workerResponseHandler = ({
  data,
}: {
  data: { url: string; result: boolean }
}) => {
  if (data.url === endpoint.value) isUrlValid.value = data.result
}

onMounted(() => {
  worker = new RegexWorker()
  worker.addEventListener("message", workerResponseHandler)

  subscribeToStream(sse.value.event$, (event) => {
    switch (event?.type) {
      case "STARTING":
        log.value = [
          {
            payload: `${t("state.connecting_to", { name: endpoint.value })}`,
            source: "info",
            color: "var(--accent-color)",
            ts: undefined,
          },
        ]
        break

      case "STARTED":
        log.value = [
          {
            payload: `${t("state.connected_to", { name: endpoint.value })}`,
            source: "info",
            color: "var(--accent-color)",
            ts: Date.now(),
          },
        ]
        toast.success(`${t("state.connected")}`)
        break

      case "MESSAGE_RECEIVED":
        addSSELogLine({
          prefix: `[${event.event ?? "message"}]`,
          payload: event.data,
          source: "server",
          ts: event.time,
        })
        break

      case "ERROR":
        addSSELogLine({
          payload:
            event.error.status !== undefined
              ? `${event.error.message} (${event.error.status} ${event.error.statusText ?? ""})`.trim()
              : event.error.message,
          source: "info",
          color: "#ff5555",
          ts: event.time,
        })
        break

      case "STOPPED":
        addSSELogLine({
          payload: t("state.disconnected_from", {
            name: endpoint.value,
          }).toString(),
          source: "disconnected",
          color: "#ff5555",
          ts: event.time,
        })
        toast.error(`${t("state.disconnected")}`)
        break
    }
  })
})

// METHODS

const toggleSSEConnection = () => {
  // If it is connecting:
  if (connectionState.value === "STOPPED") {
    const variables: Environment["variables"] = envs.value.map((v) => ({
      key: v.key,
      currentValue: v.currentValue,
      initialValue: v.initialValue,
      secret: v.secret,
    }))

    return getEffectiveRESTRequest(request.value, {
      v: 2,
      id: "env-id",
      name: "Env",
      variables,
    }).then((effectiveReq) => sse.value.start(effectiveReq))
  }
  // Otherwise, it's disconnecting.
  sse.value.stop()
}

const updateMethod = (method: string) => {
  request.value.method = method
}

const onSelectMethod = (ev: Event) => {
  const val = (ev.target as HTMLInputElement).value
  updateMethod(val.toUpperCase())
}

onUnmounted(() => {
  worker.terminate()
})
const clearLogEntries = () => {
  log.value = []
}
</script>
