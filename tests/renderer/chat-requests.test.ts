import { describe, expect, it } from 'vitest'
import {
  clearRequests,
  createRequests,
  discardExpands,
  discardExpandsForTurns,
  pendingRequest,
  registerExpand,
  registerSend,
  settleRequest
} from '../../src/renderer/src/hooks/chat/requests'

describe('chat request bookkeeping', () => {
  it('registers a send as the active request and matches it', () => {
    const book = registerSend(createRequests(), 'send-1', 10)

    expect(book.activeSendId).toBe('send-1')
    expect(pendingRequest(book, 'send-1', 'send')).toEqual({ kind: 'send', turnId: 10 })
    expect(pendingRequest(book, 'send-1', 'expand')).toBeNull()
  })

  it('tracks a concurrent send and expand independently', () => {
    let book = registerSend(createRequests(), 'send-1', 10)
    book = registerExpand(book, 'expand-1', 10, 5)

    expect(pendingRequest(book, 'send-1', 'send')).toEqual({ kind: 'send', turnId: 10 })
    expect(pendingRequest(book, 'expand-1', 'expand')).toEqual({
      kind: 'expand',
      turnId: 10,
      expansionId: 5
    })

    const settled = settleRequest(book, 'expand-1')
    expect(settled.request?.expansionId).toBe(5)
    expect(pendingRequest(settled.book, 'expand-1', 'expand')).toBeNull()
    expect(pendingRequest(settled.book, 'send-1', 'send')).not.toBeNull()
    expect(settled.book.activeSendId).toBe('send-1')
  })

  it('ignores a stale request and leaves the book untouched', () => {
    const book = registerSend(createRequests(), 'send-1', 10)
    const first = settleRequest(book, 'send-1')

    expect(first.request?.turnId).toBe(10)
    expect(first.book.activeSendId).toBeNull()

    const second = settleRequest(first.book, 'send-1')
    expect(second.request).toBeNull()
    expect(second.book).toBe(first.book)
  })

  it('drops every in-flight expand but keeps the send pending', () => {
    let book = registerSend(createRequests(), 'send-1', 10)
    book = registerExpand(book, 'expand-1', 10, 1)
    book = registerExpand(book, 'expand-2', 11, 2)

    const drained = discardExpands(book)
    expect(drained.requestIds).toEqual(['expand-1', 'expand-2'])
    expect(pendingRequest(drained.book, 'expand-1', 'expand')).toBeNull()
    expect(pendingRequest(drained.book, 'send-1', 'send')).not.toBeNull()
    expect(drained.book.activeSendId).toBe('send-1')
  })

  it('drops expands only for turns that are being replaced', () => {
    let book = createRequests()
    book = registerExpand(book, 'expand-1', 10, 1)
    book = registerExpand(book, 'expand-2', 11, 2)
    book = registerExpand(book, 'expand-3', 11, 3)

    const drained = discardExpandsForTurns(book, new Set([11]))
    expect(drained.requestIds).toEqual(['expand-2', 'expand-3'])
    expect(pendingRequest(drained.book, 'expand-1', 'expand')).not.toBeNull()
    expect(pendingRequest(drained.book, 'expand-2', 'expand')).toBeNull()
  })

  it('clearRequests drains everything and clears the active send', () => {
    let book = registerSend(createRequests(), 'send-1', 10)
    book = registerExpand(book, 'expand-1', 10, 1)

    const drained = clearRequests(book)
    expect(drained.requestIds).toEqual(['send-1', 'expand-1'])
    expect(drained.book.pending.size).toBe(0)
    expect(drained.book.activeSendId).toBeNull()
    expect(settleRequest(drained.book, 'send-1').request).toBeNull()
  })
})
