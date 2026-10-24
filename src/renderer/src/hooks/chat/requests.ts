/**
 * Request bookkeeping for streaming chat/expand IPC.
 *
 * Pure state transitions: the hook keeps the returned book in a ref, so every
 * listener reads the newest snapshot. A chunk can only be applied while its
 * requestId is still registered; cancelling a request drops it first, which is
 * what makes a stopped request unable to land on a turn.
 */

export type PendingKind = 'send' | 'expand'

export interface PendingRequest {
  kind: PendingKind
  turnId: number
  /** Only set for expand requests. */
  expansionId?: number
}

export interface RequestBookkeeping {
  pending: ReadonlyMap<string, PendingRequest>
  activeSendId: string | null
}

/** Requests removed from the book; the caller must call `chatCancel` for each. */
export interface RequestDrain {
  book: RequestBookkeeping
  requestIds: string[]
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function createRequests(): RequestBookkeeping {
  return { pending: new Map(), activeSendId: null }
}

export function registerSend(
  book: RequestBookkeeping,
  requestId: string,
  turnId: number
): RequestBookkeeping {
  const pending = new Map(book.pending)
  pending.set(requestId, { kind: 'send', turnId })
  return { pending, activeSendId: requestId }
}

export function registerExpand(
  book: RequestBookkeeping,
  requestId: string,
  turnId: number,
  expansionId: number
): RequestBookkeeping {
  const pending = new Map(book.pending)
  pending.set(requestId, { kind: 'expand', turnId, expansionId })
  return { pending, activeSendId: book.activeSendId }
}

/** The pending entry for `requestId`, but only when it is of `kind`. */
export function pendingRequest(
  book: RequestBookkeeping,
  requestId: string,
  kind: PendingKind
): PendingRequest | null {
  const pending = book.pending.get(requestId)
  return pending?.kind === kind ? pending : null
}

/** Removes a completed request; a stale id leaves the book untouched. */
export function settleRequest(
  book: RequestBookkeeping,
  requestId: string
): { book: RequestBookkeeping; request: PendingRequest | null } {
  const request = book.pending.get(requestId)
  if (!request) return { book, request: null }
  const pending = new Map(book.pending)
  pending.delete(requestId)
  return {
    book: {
      pending,
      activeSendId: book.activeSendId === requestId ? null : book.activeSendId
    },
    request
  }
}

function drain(
  book: RequestBookkeeping,
  match: (request: PendingRequest) => boolean
): RequestDrain {
  const pending = new Map<string, PendingRequest>()
  const requestIds: string[] = []
  for (const [requestId, request] of book.pending) {
    if (match(request)) requestIds.push(requestId)
    else pending.set(requestId, request)
  }
  if (requestIds.length === 0) return { book, requestIds }
  return {
    book: {
      pending,
      activeSendId:
        book.activeSendId !== null && pending.has(book.activeSendId) ? book.activeSendId : null
    },
    requestIds
  }
}

/** Drops every in-flight expand, leaving sends untouched. */
export function discardExpands(book: RequestBookkeeping): RequestDrain {
  return drain(book, (request) => request.kind === 'expand')
}

/** Drops expands attached to turns that are about to disappear. */
export function discardExpandsForTurns(
  book: RequestBookkeeping,
  turnIds: ReadonlySet<number>
): RequestDrain {
  return drain(book, (request) => request.kind === 'expand' && turnIds.has(request.turnId))
}

/** Drops every pending request (send included) and clears the active send. */
export function clearRequests(book: RequestBookkeeping): RequestDrain {
  return drain(book, () => true)
}
