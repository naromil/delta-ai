import type { ConversationMeta } from '../../../shared/conversation'

export const HOME_RECENT_LIMIT = 5

/** Compact "5m ago" style label; older than a week falls back to the locale date. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const date = new Date(iso)
  const diffMs = now - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * Newest chat conversations for the Home view. `conversation-list` already sorts by
 * `updatedAt` desc and returns chat records only; this re-checks both so the view never
 * depends on that ordering or shows a lookup record.
 */
export function pickRecentConversations(
  list: ConversationMeta[],
  limit: number = HOME_RECENT_LIMIT
): ConversationMeta[] {
  return list
    .filter((meta) => meta.source === 'chat')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, limit))
}
