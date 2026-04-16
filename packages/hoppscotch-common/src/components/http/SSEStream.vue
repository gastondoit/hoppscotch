<template>
  <div ref="container" class="flex flex-1 flex-col overflow-auto p-4">
    <pre class="whitespace-pre-wrap break-words font-mono text-secondaryDark">{{
      response.bodyText
    }}</pre>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue"
import type { HoppRESTStreamingResponse } from "~/helpers/types/HoppRESTResponse"

const props = defineProps<{
  response: HoppRESTStreamingResponse
}>()

const container = ref<HTMLElement | null>(null)

watch(
  () => props.response.bodyText,
  async () => {
    await nextTick()
    if (!container.value) return
    container.value.scrollTop = container.value.scrollHeight
  },
  { flush: "post" }
)
</script>

