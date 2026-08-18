import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { superviseSocket, type SupervisedSocket } from '../src/socket.js'

type Handlers = {
  open?: () => void
  message?: (payload: unknown) => void
  close?: (event: { code?: number, reason?: string }) => void
  error?: (error: Error) => void
}

/** A fake socket whose handler registration mirrors the SDK's overwrite semantics. */
class FakeSocket implements SupervisedSocket {
  readonly handlers: Handlers = {}
  closed = false
  /** Counts registrations per event, to catch double-subscription bugs. */
  readonly registrations = new Map<string, number>()

  on(event: 'open', handler: () => void): void
  on(event: 'message', handler: (payload: unknown) => void): void
  on(event: 'close', handler: (event: { code?: number, reason?: string }) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  on(event: string, handler: unknown): void {
    this.registrations.set(event, (this.registrations.get(event) ?? 0) + 1)
    ;(this.handlers as Record<string, unknown>)[event] = handler
  }

  close(): void {
    this.closed = true
  }
}

/** A manual timer so rebuild scheduling is deterministic. */
function manualTimer(): { setTimer: (fn: () => void, ms: number) => { cancel: () => void }, run: () => void, pending: number } {
  const queue: (() => void)[] = []
  return {
    setTimer(fn) {
      queue.push(fn)
      return {
        cancel() {
          const index = queue.indexOf(fn)
          if (index >= 0) queue.splice(index, 1)
        },
      }
    },
    run() {
      const batch = [...queue]
      queue.length = 0
      for (const fn of batch) fn()
    },
    get pending() {
      return queue.length
    },
  }
}

const settle = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)) }

describe('socket supervision', () => {
  it('re-runs onOpen after every open, so re-subscribe and backfill are covered', async () => {
    const socket = new FakeSocket()
    let opens = 0
    superviseSocket({
      connect: async () => socket,
      onOpen: () => { opens += 1 },
      onMessage: () => {},
    })
    await settle()

    socket.handlers.open?.()
    socket.handlers.open?.()

    // The SDK fires 'open' again after each internal reconnect; both must
    // re-subscribe, because a reconnected socket has no subscription.
    assert.equal(opens, 2)
  })

  it('registers exactly one handler per event on a socket', async () => {
    const socket = new FakeSocket()
    superviseSocket({ connect: async () => socket, onOpen: () => {}, onMessage: () => {} })
    await settle()

    // The SDK's listener map is array-backed and connect() appends; a second
    // registration would process every inbound email twice.
    assert.equal(socket.registrations.get('message'), 1)
    assert.equal(socket.registrations.get('open'), 1)
  })

  it('replaces the socket after a clean close it did not initiate', async () => {
    const sockets: FakeSocket[] = []
    const timer = manualTimer()
    const supervisor = superviseSocket({
      connect: async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onOpen: () => {},
      onMessage: () => {},
      setTimer: timer.setTimer,
    })
    await settle()
    assert.equal(sockets.length, 1)

    // Code 1000 arrives from _disconnect()'s default during error handling, and
    // the SDK has now disabled its own reconnection. The socket is finished.
    sockets[0]?.handlers.close?.({ code: 1000 })
    assert.equal(timer.pending, 1)
    timer.run()
    await settle()

    assert.equal(sockets.length, 2, 'a brand-new socket must replace the dead one')
    assert.equal(supervisor.rebuilds, 1)
    assert.notEqual(sockets[0], sockets[1])
  })

  it('leaves an abnormal close to the SDK, which still reconnects on its own', async () => {
    const sockets: FakeSocket[] = []
    const timer = manualTimer()
    superviseSocket({
      connect: async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onOpen: () => {},
      onMessage: () => {},
      setTimer: timer.setTimer,
    })
    await settle()

    // 1006 keeps _shouldReconnect true, so intervening would double-connect.
    sockets[0]?.handlers.close?.({ code: 1006 })
    assert.equal(timer.pending, 0)
    assert.equal(sockets.length, 1)
  })

  it('does not rebuild after its own stop()', async () => {
    const sockets: FakeSocket[] = []
    const timer = manualTimer()
    const supervisor = superviseSocket({
      connect: async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onOpen: () => {},
      onMessage: () => {},
      setTimer: timer.setTimer,
    })
    await settle()

    supervisor.stop()
    sockets[0]?.handlers.close?.({ code: 1000 })

    assert.equal(sockets[0]?.closed, true)
    assert.equal(timer.pending, 0)
    assert.equal(supervisor.rebuilds, 0)
  })

  it('gives up after the rebuild budget rather than looping forever', async () => {
    const timer = manualTimer()
    const errors: string[] = []
    const supervisor = superviseSocket({
      connect: async () => { throw new Error('unreachable') },
      onOpen: () => {},
      onMessage: () => {},
      onError: error => { errors.push(String(error)) },
      maxRebuilds: 2,
      setTimer: timer.setTimer,
    })
    await settle()

    for (let attempt = 0; attempt < 6; attempt += 1) {
      timer.run()
      await settle()
    }

    assert.equal(supervisor.rebuilds, 2)
    assert.ok(errors.some(error => error.includes('giving up')))
  })

  it('routes frames to onMessage and survives a throwing handler', async () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    const errors: string[] = []
    superviseSocket({
      connect: async () => socket,
      onOpen: () => {},
      onMessage: payload => {
        seen.push(payload)
        if (seen.length === 1) throw new Error('handler blew up')
      },
      onError: (_error, where) => { errors.push(where) },
    })
    await settle()

    socket.handlers.message?.({ type: 'message_received' })
    socket.handlers.message?.({ type: 'message_bounced' })

    assert.equal(seen.length, 2, 'one bad frame must not kill the stream')
    assert.deepEqual(errors, ['onMessage'])
  })
})
