import type { Api } from './api.ts'

/** One server-sent event. */
export type SseEvent = { event: string; id?: string; data: string }

/**
 * Incremental SSE parser: feed it text as it arrives, get complete events
 * back (an event ends at a blank line; `data:` lines are joined by newlines).
 */
export class SseParser {
  #buffer = ''

  push(text: string): SseEvent[] {
    this.#buffer += text.replace(/\r\n?/g, '\n')
    const events: SseEvent[] = []
    let end: number
    while ((end = this.#buffer.indexOf('\n\n')) !== -1) {
      const block = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 2)
      let event = 'message'
      let id: string | undefined
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue // comment / keep-alive
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'id') id = value
        else if (field === 'data') data.push(value)
      }
      if (data.length || event !== 'message') events.push({ event, id, data: data.join('\n') })
    }
    return events
  }
}

const MIN_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000
/** No bytes for this long (not even a ping) → assume a silently dropped connection and reconnect. */
const IDLE_RECONNECT_MS = 10 * 60_000

/**
 * A tRPC subscription kept open: reconnects with backoff when it drops or
 * goes silent. `onData` gets each update's payload (the `json` of the event);
 * `isInitial` marks the state replayed right after (re)connecting.
 */
export class Subscription<T> {
  readonly #api: Api
  readonly #procedure: string
  readonly #input: unknown
  readonly #onData: (data: T, isInitial: boolean) => void
  #abort: AbortController | undefined
  #stopped = false
  #failures = 0
  #retry: NodeJS.Timeout | undefined
  /** True from the server's "connected" until the stream drops. */
  connected = false

  constructor(api: Api, procedure: string, input: unknown, onData: (data: T, isInitial: boolean) => void) {
    this.#api = api
    this.#procedure = procedure
    this.#input = input
    this.#onData = onData
  }

  start() {
    void this.#run()
    return this
  }

  stop() {
    this.#stopped = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#abort?.abort()
  }

  async #run() {
    if (this.#stopped) return
    const abort = (this.#abort = new AbortController())
    let idle: NodeJS.Timeout | undefined
    const resetIdle = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => abort.abort(), IDLE_RECONNECT_MS)
    }
    try {
      const body = await this.#api.openStream(this.#procedure, this.#input, abort.signal)
      resetIdle()
      const parser = new SseParser()
      const decoder = new TextDecoder()
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        resetIdle()
        for (const e of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (e.event === 'connected') {
            this.#failures = 0
            this.connected = true
            continue
          }
          if (e.event !== 'message' || !e.data) continue
          try {
            const payload = (JSON.parse(e.data) as { json: T }).json
            this.#onData(payload, e.id === 'initial')
          } catch (err) {
            console.warn(`[stream] ${this.#procedure}: bad event`, err instanceof Error ? err.message : err)
          }
        }
      }
    } catch (err) {
      if (!this.#stopped && !abort.signal.aborted) {
        console.warn(`[stream] ${this.#procedure} dropped:`, err instanceof Error ? err.message : err)
      }
    } finally {
      if (idle) clearTimeout(idle)
      this.connected = false
    }
    if (this.#stopped) return
    this.#failures++
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(this.#failures - 1, 5))
    this.#retry = setTimeout(() => void this.#run(), delay)
  }
}
