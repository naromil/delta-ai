import { BrowserWindow } from 'electron'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { buildMemoryPrompt, MEMORY_PATH_HINT, MEMORY_TOOL_DESCRIPTIONS } from '../../shared/prompts'
import type { RoleId } from '../../shared/models'
import { resolveRole } from '../config'
import type { AgentTools } from '../provider'
import { getCachedModel } from '../services/model-catalog'
import {
  editMemory,
  grepMemories,
  listMemories,
  makeMemoryDirectory,
  memoriesDir,
  MemoryError,
  moveMemory,
  readAutoLoadedMemories,
  readMemory,
  removeMemory,
  writeMemory
} from './store'

const ASSISTANT_MAX_STEPS = 10
/** The curator reads, rewrites several files and refreshes meta-files in one pass. */
const CURATOR_MAX_STEPS = 25

const pathInput = z.string().describe(MEMORY_PATH_HINT)

/** The model reads a failure as a tool result and can correct itself; absolute paths stay out. */
function report(operation: () => string): string {
  try {
    return operation()
  } catch (err) {
    if (err instanceof MemoryError) return `Error: ${err.message}`
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    return `Error: the filesystem refused this operation (${code}).`
  }
}

export function createMemoryTools(root: string, onChange: () => void): ToolSet {
  const mutate = (operation: () => string): string =>
    report(() => {
      const result = operation()
      onChange()
      return result
    })

  return {
    memory_ls: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.ls,
      inputSchema: z.object({ path: pathInput }),
      execute: ({ path }) => report(() => listMemories(root, path))
    }),
    memory_cat: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.cat,
      inputSchema: z.object({ path: pathInput }),
      execute: ({ path }) => report(() => readMemory(root, path))
    }),
    memory_grep: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.grep,
      inputSchema: z.object({ text: z.string(), path: pathInput }),
      execute: ({ text, path }) => report(() => grepMemories(root, text, path))
    }),
    memory_write: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.write,
      inputSchema: z.object({ path: pathInput, content: z.string() }),
      execute: ({ path, content }) => mutate(() => writeMemory(root, path, content))
    }),
    memory_edit: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.edit,
      inputSchema: z.object({ path: pathInput, old_text: z.string(), new_text: z.string() }),
      execute: ({ path, old_text, new_text }) =>
        mutate(() => editMemory(root, path, old_text, new_text))
    }),
    memory_mkdir: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.mkdir,
      inputSchema: z.object({ path: pathInput }),
      execute: ({ path }) => mutate(() => makeMemoryDirectory(root, path))
    }),
    memory_mv: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.mv,
      inputSchema: z.object({ from: pathInput, to: pathInput }),
      execute: ({ from, to }) => mutate(() => moveMemory(root, from, to))
    }),
    memory_rm: tool({
      description: MEMORY_TOOL_DESCRIPTIONS.rm,
      inputSchema: z.object({ path: pathInput, recursive: z.boolean() }),
      execute: ({ path, recursive }) => mutate(() => removeMemory(root, path, recursive))
    })
  }
}

function catalogSaysNoTools(role: RoleId): boolean {
  const resolved = resolveRole(role)
  if (!resolved) return false
  const model = getCachedModel(resolved.connection.providerType, resolved.model)
  return model !== null && !model.toolCall
}

/** Every window shows the indicator: the curator writes with no reply on screen to attach it to. */
function broadcastMemoryUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send('memory-updated')
    } catch (err) {
      console.warn('Failed to announce a memory update:', err)
    }
  }
}

/**
 * The memory tools for one request. Never throws: memory problems must not be why a
 * message fails. A curator pass treats `undefined` as a failure, since it can do nothing else.
 */
export function memoryAgentFor(role: RoleId): AgentTools | undefined {
  try {
    if (catalogSaysNoTools(role)) return undefined
    const root = memoriesDir()
    const curating = role === 'kb-maintenance'
    return {
      tools: createMemoryTools(root, broadcastMemoryUpdated),
      instructions: buildMemoryPrompt(
        listMemories(root),
        readAutoLoadedMemories(root),
        curating ? 'curator' : 'assistant'
      ),
      maxSteps: curating ? CURATOR_MAX_STEPS : ASSISTANT_MAX_STEPS,
      toolsRequired: curating
    }
  } catch (err) {
    console.warn('Memory tools are unavailable for this request:', err)
    return undefined
  }
}
