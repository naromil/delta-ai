import { budgetFor, estimateTokens, trimMessages } from '../shared/context-budget'
import type { ProviderMessage } from './provider'
import type { RoleId } from '../shared/models'
import { resolveRole } from './config'
import { getCachedModel } from './services/model-catalog'

/**
 * Drops the oldest chat messages that no longer fit the resolved model's
 * context window. Every missing input (unassigned role, unknown model, no
 * context window in the catalog) leaves the messages untouched: trimming must
 * never be the reason a request fails.
 */
export function applyContextBudget(messages: ProviderMessage[], role: RoleId): ProviderMessage[] {
  try {
    const resolved = resolveRole(role)
    if (!resolved) return messages

    const model = getCachedModel(resolved.connection.providerType, resolved.model)
    if (!model) return messages

    const budget = budgetFor(model.contextWindow, model.maxOutput)
    if (budget === null) return messages

    const { messages: trimmed, dropped } = trimMessages(messages, budget)
    if (dropped > 0) {
      const remaining = trimmed.reduce((total, msg) => total + estimateTokens(msg.content), 0)
      console.warn(
        `Context budget trimmed ${dropped} message(s) for role "${role}" ` +
          `(${resolved.model}); ~${remaining} tokens remain of a ${budget} budget.`
      )
    }
    return trimmed
  } catch {
    return messages
  }
}
