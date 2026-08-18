/**
 * WebSocket supervision.
 *
 * The SDK's ReconnectingWebSocket only half-works, which is why this exists:
 *
 * - A network drop closes with code 1006, `_shouldReconnect` stays true, and it
 *   reconnects with backoff. That path is good, and we stay out of it.
 * - An error or connection timeout runs `_handleError` → `_disconnect(undefined)`,
 *   whose `code` defaults to **1000**, and `_handleClose` sets
 *   `_shouldReconnect = false` for code 1000. Auto-reconnect is then dead for
 *   the life of that socket, silently.
 * - Exhausting `maxRetries` returns without dispatching any event at all.
 *
 * So: let the SDK handle 1006, and supervise the rest. A close with code 1000
 * that we did not initiate means the socket will never recover on its own, and
 * the supervisor replaces it with a brand-new one.
 *
 * The replacement must be a NEW socket. `WebsocketsSocket.connect()` re-runs
 * `addEventListener` for all four events over an array-backed listener map, so
 * reusing a live socket doubles every handler and each inbound email would be
 * processed twice.
 * @module dsh-agentmail/socket
 */

/** WebSocket readyState for an open connection. */
export const READY_STATE_OPEN = 1

/** The socket surface this module drives. */
export interface SupervisedSocket {
  /** Current connection state; `connect()` may resolve already OPEN. */
  readonly readyState?: number
  on(event: 'open', handler: () => void): void
  on(event: 'message', handler: (payload: unknown) => void): void
  on(event: 'close', handler: (event: { code?: number; reason?: string }) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  close(): void
}

/** Options for {@link superviseSocket}. */
export interface SuperviseOptions {
  /** Build a brand-new socket. Never returns a previously used one. */
  connect: () => Promise<SupervisedSocket>
  /** Runs on every open, including after an SDK-internal reconnect. */
  onOpen: (socket: SupervisedSocket) => void
  /** Runs for every received frame. */
  onMessage: (payload: unknown) => void
  /** Non-fatal diagnostics. */
  onError?: (error: unknown, context: string) => void
  /** Notified when the supervisor replaces a socket. */
  onReplace?: (reason: string) => void
  /** Delay before rebuilding, in ms. */
  rebuildDelayMs?: number
  /** Rebuild attempts before giving up. */
  maxRebuilds?: number
  /** Injected timer, for tests. */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

/** A running supervisor. */
export interface Supervisor {
  /** Stop supervising and close the current socket. */
  stop(): void
  /** Rebuild count, for tests and diagnostics. */
  readonly rebuilds: number
}

const DEFAULT_REBUILD_DELAY_MS = 5_000
const DEFAULT_MAX_REBUILDS = 10

/**
 * Keep one live socket, replacing it when the SDK's own reconnection is dead.
 * @param options - supervision policy and callbacks.
 * @returns the supervisor handle.
 */
export function superviseSocket(options: SuperviseOptions): Supervisor {
  const rebuildDelayMs = options.rebuildDelayMs ?? DEFAULT_REBUILD_DELAY_MS
  const maxRebuilds = options.maxRebuilds ?? DEFAULT_MAX_REBUILDS
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    return { cancel: () => { clearTimeout(handle) } }
  })

  let stopped = false
  let current: SupervisedSocket | undefined
  let pendingTimer: { cancel: () => void } | undefined
  let rebuilds = 0
  /** Set while we are deliberately closing, so our own close is not a failure. */
  let closingOurselves = false

  const scheduleRebuild = (reason: string): void => {
    if (stopped) return
    if (rebuilds >= maxRebuilds) {
      options.onError?.(
        new Error(`giving up after ${rebuilds} socket rebuilds (last reason: ${reason})`),
        'supervisor',
      )
      return
    }
    rebuilds += 1
    options.onReplace?.(reason)
    pendingTimer?.cancel()
    pendingTimer = setTimer(() => { void start() }, rebuildDelayMs)
  }

  const start = async (): Promise<void> => {
    if (stopped) return
    try {
      const socket = await options.connect()
      if (stopped) {
        socket.close()
        return
      }
      current = socket

      const fireOpen = (): void => {
        try {
          options.onOpen(socket)
        } catch (error) {
          options.onError?.(error, 'onOpen')
        }
      }

      // Fires again after an SDK-internal reconnect, so re-subscription and
      // backfill belong here rather than in a one-shot after connect.
      socket.on('open', fireOpen)

      socket.on('message', payload => {
        try {
          options.onMessage(payload)
        } catch (error) {
          options.onError?.(error, 'onMessage')
        }
      })

      socket.on('close', event => {
        if (stopped || closingOurselves) return
        // Code 1000 we did not initiate: the SDK has disabled its own
        // reconnection, so this socket is finished whether or not it looks it.
        if (event.code === 1000) scheduleRebuild('clean close disabled auto-reconnect')
      })

      socket.on('error', error => {
        options.onError?.(error, 'socket')
      })

      // `connect()` resolves with the socket ALREADY OPEN, so the 'open' event
      // has come and gone before any handler above was attached. Without this,
      // onOpen never runs, the subscription is never sent, and not one inbound
      // message ever arrives. A later reconnect still fires the event normally.
      if (socket.readyState === READY_STATE_OPEN) fireOpen()
    } catch (error) {
      options.onError?.(error, 'connect')
      scheduleRebuild('connect failed')
    }
  }

  void start()

  return {
    stop() {
      stopped = true
      closingOurselves = true
      pendingTimer?.cancel()
      try {
        current?.close()
      } catch {
        // A socket that never opened may throw on close; teardown continues.
      }
      current = undefined
    },
    get rebuilds() {
      return rebuilds
    },
  }
}
