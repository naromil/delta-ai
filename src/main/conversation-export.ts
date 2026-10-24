import { BrowserWindow, dialog } from 'electron'
import type { ConversationRecord, ExpansionNode } from '../shared/conversation'
import { loadConversation } from './conversations'
import { writeFileAtomic } from './services/atomic-file'

const EXPORT_FALLBACK_TITLE = 'conversation'
const FILE_NAME_MAX_LENGTH = 80

/** One presented block of an expansion, nested one quote level deeper per reply. */
function expansionLines(node: ExpansionNode, depth: number): string[] {
  const prefix = '> '.repeat(depth)
  const prompt = node.prompt ? ` — ${node.prompt}` : ''
  const lines = [`${prefix}**Expansion on “${node.originalText}”**${prompt}`]
  const answer = node.answer.trimEnd()
  if (answer) {
    for (const line of answer.split('\n')) lines.push(`${prefix}${line}`)
  }
  for (const child of node.children) lines.push(...expansionLines(child, depth + 1))
  return lines
}

/** Renders a conversation as standalone markdown, expansions quoted inline. */
export function renderConversationMarkdown(record: ConversationRecord): string {
  const lines = [
    `# ${record.title}`,
    '',
    `_Created ${record.createdAt} · Updated ${record.updatedAt}_`
  ]

  for (const turn of record.state.turns) {
    // Same rule as serializeForChat: failed and blank assistant turns are not content.
    if (turn.role === 'assistant' && (turn.error || turn.content.trim() === '')) continue

    lines.push('', turn.role === 'user' ? '## You' : '## Delta AI')
    const body = turn.content.trimEnd()
    if (body) lines.push(body)
    for (const expansion of turn.expansions) {
      lines.push('', ...expansionLines(expansion, 1))
    }
  }

  return `${lines.join('\n')}\n`
}

function exportFileName(record: ConversationRecord): string {
  const printable = [...record.title].filter((char) => char.charCodeAt(0) >= 32).join('')
  const sanitized = printable
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_NAME_MAX_LENGTH)
    .trim()
  return `${sanitized || `${EXPORT_FALLBACK_TITLE}-${record.id}`}.md`
}

/** Saves one conversation as markdown through the system save dialog. */
export async function exportConversationToFile(
  id: string
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const record = await loadConversation(id)
  if (!record) return { ok: false, error: 'Conversation not found.' }

  const options = {
    defaultPath: exportFileName(record),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }
  const owner = BrowserWindow.getFocusedWindow()
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) return { ok: false, error: 'Canceled.' }

  try {
    await writeFileAtomic(result.filePath, renderConversationMarkdown(record))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: result.filePath }
}
