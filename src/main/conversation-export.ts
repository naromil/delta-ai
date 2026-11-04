import { BrowserWindow, dialog } from 'electron'
import { cardText } from '../shared/canvas-selection'
import type { CanvasRecord, ConversationRecord, ExpansionNode } from '../shared/conversation'
import { flattenMarkdown } from '../shared/rich-text'
import { loadConversation } from './conversations'
import { writeFileAtomic } from './services/atomic-file'

const EXPORT_FALLBACK_TITLE = 'conversation'
const FILE_NAME_MAX_LENGTH = 80
const LINK_NAME_MAX_LENGTH = 60

/** One presented block of an expansion, nested one quote level deeper per reply. */
function expansionLines(node: ExpansionNode, depth: number): string[] {
  const prefix = '> '.repeat(depth)
  const prompt = node.prompt ? ` — ${node.prompt}` : ''
  const lines = [`${prefix}**Expansion on “${node.originalText}”**${prompt}`]
  for (const attachment of node.attachments ?? []) {
    lines.push(`${prefix}_[Image: ${attachment.name}]_`)
  }
  const answer = node.answer.trimEnd()
  if (answer) {
    for (const line of answer.split('\n')) lines.push(`${prefix}${line}`)
  }
  for (const child of node.children) lines.push(...expansionLines(child, depth + 1))
  return lines
}

/** A canvas's notes and connections, which hold no turn and so appear nowhere else. */
function canvasLines(record: CanvasRecord): string[] {
  const layout = record.canvas
  const { turns } = record.state
  const notes = layout.cards.filter((card) => card.kind === 'note')
  const nameOf = (id: string): string => {
    const card = layout.cards.find((item) => item.id === id)
    if (!card) return 'a removed card'
    const { title, body } = cardText(card, turns)
    const name = flattenMarkdown(title || body)
      .replace(/\s+/g, ' ')
      .trim()
    return name.length > LINK_NAME_MAX_LENGTH ? `${name.slice(0, LINK_NAME_MAX_LENGTH)}…` : name
  }
  const lines: string[] = []
  if (notes.length > 0) {
    lines.push('', '## Notes')
    for (const note of notes) lines.push('', note.text.trimEnd())
  }
  if (layout.links.length > 0) {
    lines.push('', '## Connections', '')
    for (const link of layout.links) {
      const relation = link.label ? ` — ${link.label} → ` : ' → '
      lines.push(`- ${nameOf(link.from)}${relation}${nameOf(link.to)}`)
    }
  }
  return lines
}

/** The lines only one type has; each type adds its own here. */
function typeLines(record: ConversationRecord): { before: string[]; after: string[] } {
  if (record.source === 'canvas') return { before: [], after: canvasLines(record) }
  if (record.source === 'lookup' && record.lookup.context.trim() !== '') {
    return { before: ['', '## Screen context', '', record.lookup.context.trimEnd()], after: [] }
  }
  return { before: [], after: [] }
}

/** Renders a conversation as standalone markdown, expansions quoted inline. */
export function renderConversationMarkdown(record: ConversationRecord): string {
  const { before, after } = typeLines(record)
  const lines = [
    `# ${record.title}`,
    '',
    `_Created ${record.createdAt} · Updated ${record.updatedAt}_`,
    ...before
  ]

  for (const turn of record.state.turns) {
    // Same rule as serializeForChat: failed and blank assistant turns are not content.
    if (turn.role === 'assistant' && (turn.error || turn.content.trim() === '')) continue

    lines.push('', turn.role === 'user' ? '## You' : '## Delta AI')
    for (const attachment of turn.attachments ?? []) lines.push(`_[Image: ${attachment.name}]_`)
    const body = turn.content.trimEnd()
    if (body) lines.push(body)
    for (const expansion of turn.expansions) {
      lines.push('', ...expansionLines(expansion, 1))
    }
  }

  lines.push(...after)
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
