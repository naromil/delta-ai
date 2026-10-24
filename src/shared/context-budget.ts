import type { ProviderMessage } from './models'

/** Reserved for the reply when the caller does not know the model's output cap. */
export const DEFAULT_OUTPUT_RESERVE = 4096

/** Rough token estimate: 4 characters per token, never zero for real content. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Input budget for a context window, leaving room for the reply. `null` means
 * the caller has no usable window, so no trimming should happen.
 */
export function budgetFor(contextWindow?: number, maxOutput?: number): number | null {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null
  }
  const requested = maxOutput !== undefined && Number.isFinite(maxOutput) && maxOutput > 0
  const reserve = Math.min(
    requested ? maxOutput : DEFAULT_OUTPUT_RESERVE,
    Math.floor(contextWindow / 2)
  )
  return Math.max(1024, Math.floor(contextWindow * 0.85) - reserve)
}

/**
 * Drops the oldest non-system messages (never the final one) until the
 * estimated total fits the budget. The input array and messages are untouched.
 */
export function trimMessages(
  messages: ProviderMessage[],
  budget: number
): { messages: ProviderMessage[]; dropped: number } {
  const kept = [...messages]
  let dropped = 0
  while (kept.reduce((total, message) => total + estimateTokens(message.content), 0) > budget) {
    const index = kept.findIndex((message, i) => i !== kept.length - 1 && message.role !== 'system')
    if (index === -1) break
    kept.splice(index, 1)
    dropped++
  }
  return { messages: kept, dropped }
}
