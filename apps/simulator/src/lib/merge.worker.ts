import type { FeatureCollection } from 'geojson'
import { mergeTraces } from '@windstone/merger'
import { evaluateNetwork } from '@windstone/merger/evaluate'

export interface MergeRequest {
  walks: FeatureCollection
  truth: FeatureCollection
}

export interface MergeSuccess {
  result: ReturnType<typeof mergeTraces>
  score: ReturnType<typeof evaluateNetwork>
  durationMs: number
}

export type MergeResponse = { ok: true; data: MergeSuccess } | { ok: false; error: string }

self.addEventListener('message', (event: MessageEvent<MergeRequest>) => {
  try {
    const started = performance.now()
    const result = mergeTraces(event.data.walks)
    const score = evaluateNetwork(result.trails, event.data.truth)
    const response: MergeResponse = { ok: true, data: { result, score, durationMs: performance.now() - started } }
    self.postMessage(response)
  } catch (error) {
    const response: MergeResponse = { ok: false, error: error instanceof Error ? error.message : 'Merge failed.' }
    self.postMessage(response)
  }
})