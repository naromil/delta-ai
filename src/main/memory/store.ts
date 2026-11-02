import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs'
import type { Stats } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { writeFileAtomicSync } from '../services/atomic-file'
import { AUTO_LOADED_MEMORY_PREFIX, type AutoLoadedMemory } from '../../shared/prompts'

/* ---- Memory document base ----
 * A tree of markdown files under `{userData}/memories/`, managed by the
 * assistant through shell-like operations. Paths come from a model, whose input
 * can include screen text, so every path is confined to the root here. There is
 * deliberately no real shell. The operations are synchronous, so each one is
 * atomic on the event loop and parallel tool calls cannot interleave.
 */

export const MAX_MEMORY_FILE_CHARS = 32_000
const MAX_LISTED_ENTRIES = 200
const MAX_GREP_MATCHES = 100
const MAX_GREP_LINE_CHARS = 200
/** These go into every system prompt, so they are held well below the per-file limit. */
const MAX_AUTO_LOADED_FILE_CHARS = 8_000
const MAX_AUTO_LOADED_TOTAL_CHARS = 16_000

/** A refusal worded for the model; anything else is an unexpected filesystem failure. */
export class MemoryError extends Error {}

export function memoriesDir(): string {
  const dir = join(app.getPath('userData'), 'memories')
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ---- Path confinement ---- */

interface MemoryPath {
  absolute: string
  /** Relative to the root with `/` separators; empty for the root itself. */
  relative: string
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function locate(root: string, input: string): MemoryPath {
  const normalized = input.trim().replaceAll('\\', '/')
  // eslint-disable-next-line no-control-regex
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || /[\x00-\x1f]/.test(input)) {
    throw new MemoryError(`Invalid path "${input}": use a path relative to the memories directory.`)
  }
  const segments = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.includes('..')) {
    throw new MemoryError(`Invalid path "${input}": ".." is not allowed.`)
  }
  let absolute = root
  for (const segment of segments) {
    absolute = join(absolute, segment)
    if (lstatOrNull(absolute)?.isSymbolicLink()) {
      throw new MemoryError(`Invalid path "${input}": symbolic links are not followed.`)
    }
  }
  return { absolute, relative: segments.join('/') }
}

function locateMarkdown(root: string, input: string): MemoryPath {
  const located = locate(root, input)
  if (!isMarkdownName(located.relative)) {
    throw new MemoryError(`"${input}" is not a markdown file: names must end in .md.`)
  }
  return located
}

function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

function statOrThrow(path: MemoryPath): Stats {
  const stats = lstatOrNull(path.absolute)
  if (!stats) throw new MemoryError(`No such file or directory: ${path.relative || '.'}`)
  return stats
}

function assertFits(content: string): void {
  if (content.length > MAX_MEMORY_FILE_CHARS) {
    throw new MemoryError(
      `Content is ${content.length} characters; the limit is ${MAX_MEMORY_FILE_CHARS} per file. Split it into several files.`
    )
  }
}

/* ---- Traversal ---- */

interface MemoryEntry {
  relative: string
  isDirectory: boolean
}

/** Depth-first, sorted. Symlinks and non-markdown files (temp files included) are invisible. */
function* walk(directory: MemoryPath): Generator<MemoryEntry> {
  const entries = readdirSync(directory.absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (const entry of entries) {
    const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield { relative, isDirectory: true }
      yield* walk({ absolute: join(directory.absolute, entry.name), relative })
    } else if (entry.isFile() && isMarkdownName(entry.name)) {
      yield { relative, isDirectory: false }
    }
  }
}

/* ---- Read operations ---- */

/** `ls -R`: every markdown file and directory below `path`, one per line. */
export function listMemories(root: string, path = '.'): string {
  const target = locate(root, path)
  if (!statOrThrow(target).isDirectory()) return target.relative

  const lines: string[] = []
  for (const entry of walk(target)) {
    if (lines.length === MAX_LISTED_ENTRIES) {
      lines.push(`… listing truncated at ${MAX_LISTED_ENTRIES} entries`)
      break
    }
    lines.push(entry.isDirectory ? `${entry.relative}/` : entry.relative)
  }
  return lines.length > 0 ? lines.join('\n') : '(empty)'
}

export function readMemory(root: string, path: string): string {
  const target = locateMarkdown(root, path)
  if (!statOrThrow(target).isFile()) throw new MemoryError(`Not a file: ${target.relative}`)
  const content = readFileSync(target.absolute, 'utf-8')
  if (content.length <= MAX_MEMORY_FILE_CHARS) return content
  return `${content.slice(0, MAX_MEMORY_FILE_CHARS)}\n… file truncated at ${MAX_MEMORY_FILE_CHARS} characters`
}

/** Every file named `index*` directly in the root, for the system prompt. Symlinks are skipped. */
export function readAutoLoadedMemories(root: string): AutoLoadedMemory[] {
  const paths = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        isMarkdownName(entry.name) &&
        entry.name.toLowerCase().startsWith(AUTO_LOADED_MEMORY_PREFIX)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const loaded: AutoLoadedMemory[] = []
  let remaining = MAX_AUTO_LOADED_TOTAL_CHARS
  for (const path of paths) {
    const limit = Math.min(MAX_AUTO_LOADED_FILE_CHARS, remaining)
    let content: string
    try {
      content = readMemory(root, path)
    } catch {
      continue
    }
    remaining -= Math.min(content.length, limit)
    loaded.push({
      path,
      content:
        content.length <= limit
          ? content
          : `${content.slice(0, limit)}\n… truncated; read the file for the rest, and shorten it`
    })
  }
  return loaded
}

function clipLine(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_GREP_LINE_CHARS
    ? `${trimmed.slice(0, MAX_GREP_LINE_CHARS)}…`
    : trimmed
}

/** Case-insensitive literal search: a model-written regex could hang the main process. */
export function grepMemories(root: string, pattern: string, path = '.'): string {
  const needle = pattern.toLowerCase()
  if (needle === '') throw new MemoryError('The search text must not be empty.')
  const target = locate(root, path)
  const stats = statOrThrow(target)
  const files: MemoryEntry[] = stats.isDirectory()
    ? [...walk(target)].filter((entry) => !entry.isDirectory)
    : [{ relative: target.relative, isDirectory: false }]

  const matches: string[] = []
  for (const file of files) {
    const lines = readFileSync(join(root, file.relative), 'utf-8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue
      if (matches.length === MAX_GREP_MATCHES) {
        matches.push(`… results truncated at ${MAX_GREP_MATCHES} matches`)
        return matches.join('\n')
      }
      matches.push(`${file.relative}:${index + 1}: ${clipLine(line)}`)
    }
  }
  return matches.length > 0 ? matches.join('\n') : '(no matches)'
}

/* ---- Write operations ---- */

/** Creates or replaces a file, creating its parent directories. */
export function writeMemory(root: string, path: string, content: string): string {
  const target = locateMarkdown(root, path)
  assertFits(content)
  writeFileAtomicSync(target.absolute, content)
  return `Wrote ${target.relative}`
}

/** Replaces one exact occurrence, so an edit never lands somewhere unintended. */
export function editMemory(root: string, path: string, oldText: string, newText: string): string {
  const target = locateMarkdown(root, path)
  if (!statOrThrow(target).isFile()) throw new MemoryError(`Not a file: ${target.relative}`)
  if (oldText === '') throw new MemoryError('The text to replace must not be empty.')
  const content = readFileSync(target.absolute, 'utf-8')
  const occurrences = content.split(oldText).length - 1
  if (occurrences !== 1) {
    throw new MemoryError(
      `The text to replace occurs ${occurrences} times in ${target.relative}; it must occur exactly once.`
    )
  }
  const index = content.indexOf(oldText)
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length)
  assertFits(updated)
  writeFileAtomicSync(target.absolute, updated)
  return `Edited ${target.relative}`
}

export function makeMemoryDirectory(root: string, path: string): string {
  const target = locate(root, path)
  if (target.relative === '') return 'The memories directory already exists.'
  if (isMarkdownName(target.relative)) {
    throw new MemoryError(`A directory must not be named like a markdown file: ${path}`)
  }
  mkdirSync(target.absolute, { recursive: true })
  return `Created ${target.relative}/`
}

export function moveMemory(root: string, from: string, to: string): string {
  const source = locate(root, from)
  const destination = locate(root, to)
  if (source.relative === '' || destination.relative === '') {
    throw new MemoryError('The memories directory itself cannot be moved or replaced.')
  }
  const stats = statOrThrow(source)
  if (stats.isFile() && !isMarkdownName(destination.relative)) {
    throw new MemoryError(`"${to}" is not a markdown file: names must end in .md.`)
  }
  if (destination.relative.startsWith(`${source.relative}/`)) {
    throw new MemoryError('A directory cannot be moved into itself.')
  }
  if (lstatOrNull(destination.absolute)) {
    throw new MemoryError(`Already exists: ${destination.relative}`)
  }
  mkdirSync(dirname(destination.absolute), { recursive: true })
  renameSync(source.absolute, destination.absolute)
  return `Moved ${source.relative} to ${destination.relative}`
}

export function removeMemory(root: string, path: string, recursive = false): string {
  const target = locate(root, path)
  if (target.relative === '') throw new MemoryError('The memories directory cannot be removed.')
  const stats = statOrThrow(target)
  if (stats.isDirectory()) {
    if (!recursive && readdirSync(target.absolute).length > 0) {
      throw new MemoryError(
        `Directory is not empty: ${target.relative}. Set recursive to remove it.`
      )
    }
    rmSync(target.absolute, { recursive: true })
    return `Removed ${target.relative}/`
  }
  if (!isMarkdownName(target.relative)) {
    throw new MemoryError(`"${path}" is not a markdown file: names must end in .md.`)
  }
  rmSync(target.absolute)
  return `Removed ${target.relative}`
}
