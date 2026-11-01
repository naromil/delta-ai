import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData }
}))

import {
  editMemory,
  grepMemories,
  listMemories,
  makeMemoryDirectory,
  MAX_MEMORY_FILE_CHARS,
  memoriesDir,
  MemoryError,
  moveMemory,
  readMemory,
  removeMemory,
  writeMemory
} from '../../src/main/memory/store'

let base: string
let root: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delta-memory-'))
  paths.userData = base
  root = memoriesDir()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('memoriesDir', () => {
  it('lives directly in the app storage directory', () => {
    expect(root).toBe(join(base, 'memories'))
    expect(existsSync(root)).toBe(true)
  })
})

describe('path confinement', () => {
  it.each(['../secret.md', 'a/../../secret.md', '/etc/passwd.md', 'C:\\x.md', '..\\secret.md'])(
    'refuses %s for every kind of operation',
    (path) => {
      expect(() => writeMemory(root, path, 'x')).toThrow(MemoryError)
      expect(() => readMemory(root, path)).toThrow(MemoryError)
      expect(() => listMemories(root, path)).toThrow(MemoryError)
      expect(() => removeMemory(root, path, true)).toThrow(MemoryError)
      expect(() => moveMemory(root, path, 'in.md')).toThrow(MemoryError)
    }
  )

  it('does not write outside through a symlink in the tree', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'link'))
    expect(() => writeMemory(root, 'link/escape.md', 'x')).toThrow(MemoryError)
    expect(existsSync(join(outside, 'escape.md'))).toBe(false)
    expect(listMemories(root)).toBe('(empty)')
  })

  it('does not read through a symlinked file', () => {
    const secret = join(base, 'providers.md')
    writeFileSync(secret, 'key')
    symlinkSync(secret, join(root, 'keys.md'))
    expect(() => readMemory(root, 'keys.md')).toThrow(MemoryError)
    expect(grepMemories(root, 'key')).toBe('(no matches)')
  })

  it('only manages markdown files', () => {
    expect(() => writeMemory(root, 'run.sh', 'x')).toThrow(/markdown/)
    writeMemory(root, 'a.md', 'x')
    expect(() => moveMemory(root, 'a.md', 'a.sh')).toThrow(/markdown/)
    writeFileSync(join(root, 'hand-placed.json'), '{}')
    expect(listMemories(root)).toBe('a.md')
    expect(() => readMemory(root, 'hand-placed.json')).toThrow(/markdown/)
    expect(() => removeMemory(root, 'hand-placed.json')).toThrow(/markdown/)
  })

  it('protects the root itself', () => {
    expect(() => removeMemory(root, '.', true)).toThrow(MemoryError)
    expect(() => moveMemory(root, '.', 'x')).toThrow(MemoryError)
    expect(() => moveMemory(root, 'x', '.')).toThrow(MemoryError)
    expect(existsSync(root)).toBe(true)
  })
})

describe('nested documents', () => {
  it('creates parents on write and lists the tree', () => {
    writeMemory(root, 'work/projects/delta.md', '# Delta')
    writeMemory(root, 'profile.md', 'hi')
    expect(listMemories(root).split('\n')).toEqual([
      'profile.md',
      'work/',
      'work/projects/',
      'work/projects/delta.md'
    ])
    expect(listMemories(root, 'work/projects')).toBe('work/projects/delta.md')
    expect(readMemory(root, './work//projects/delta.md')).toBe('# Delta')
  })

  it('makes directories and refuses a markdown-named one', () => {
    expect(makeMemoryDirectory(root, 'people/family')).toBe('Created people/family/')
    expect(listMemories(root)).toBe('people/\npeople/family/')
    expect(() => makeMemoryDirectory(root, 'notes.md')).toThrow(MemoryError)
  })

  it('caps listings', () => {
    for (let index = 0; index < 205; index++) writeFileSync(join(root, `${index}.md`), '')
    const lines = listMemories(root).split('\n')
    expect(lines).toHaveLength(201)
    expect(lines[200]).toMatch(/truncated/)
  })
})

describe('edit', () => {
  it('replaces exactly one occurrence, literally', () => {
    writeMemory(root, 'a.md', 'likes $& tea')
    editMemory(root, 'a.md', 'tea', 'coffee $&')
    expect(readMemory(root, 'a.md')).toBe('likes $& coffee $&')
  })

  it('refuses missing and ambiguous targets without changing the file', () => {
    writeMemory(root, 'a.md', 'x x')
    expect(() => editMemory(root, 'a.md', 'x', 'y')).toThrow(/2 times/)
    expect(() => editMemory(root, 'a.md', 'z', 'y')).toThrow(/0 times/)
    expect(() => editMemory(root, 'a.md', '', 'y')).toThrow(MemoryError)
    expect(() => editMemory(root, 'none.md', 'x', 'y')).toThrow(/No such/)
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('x x')
  })
})

describe('size limit', () => {
  it('refuses oversized writes and edits, truncates a hand-placed big file on read', () => {
    const big = 'x'.repeat(MAX_MEMORY_FILE_CHARS)
    expect(() => writeMemory(root, 'a.md', `${big}x`)).toThrow(/limit/)
    writeMemory(root, 'a.md', big)
    expect(() => editMemory(root, 'a.md', 'xx', 'yyy')).toThrow(MemoryError)
    writeFileSync(join(root, 'huge.md'), `${big}${big}`)
    expect(readMemory(root, 'huge.md')).toMatch(/truncated/)
  })
})

describe('grep', () => {
  it('finds literal text case-insensitively with path and line', () => {
    writeMemory(root, 'work/a.md', 'first\nLikes (Rust)')
    writeMemory(root, 'b.md', 'likes (rust) too')
    expect(grepMemories(root, 'likes (RUST').split('\n')).toEqual([
      'b.md:1: likes (rust) too',
      'work/a.md:2: Likes (Rust)'
    ])
    expect(grepMemories(root, 'first', 'work/a.md')).toBe('work/a.md:1: first')
    expect(grepMemories(root, 'nothing')).toBe('(no matches)')
    expect(() => grepMemories(root, '')).toThrow(MemoryError)
  })
})

describe('mv and rm', () => {
  it('moves files and directories, creating parents, never overwriting', () => {
    writeMemory(root, 'a.md', '1')
    writeMemory(root, 'b.md', '2')
    expect(() => moveMemory(root, 'a.md', 'b.md')).toThrow(/Already exists/)
    moveMemory(root, 'a.md', 'deep/er/a.md')
    moveMemory(root, 'deep', 'moved')
    expect(readMemory(root, 'moved/er/a.md')).toBe('1')
    expect(readMemory(root, 'b.md')).toBe('2')
    expect(() => moveMemory(root, 'moved', 'moved/inner')).toThrow(/into itself/)
    expect(() => moveMemory(root, 'gone.md', 'x.md')).toThrow(/No such/)
  })

  it('removes a non-empty directory only when asked to', () => {
    writeMemory(root, 'dir/a.md', '1')
    expect(() => removeMemory(root, 'dir')).toThrow(/not empty/)
    removeMemory(root, 'dir/a.md')
    removeMemory(root, 'dir')
    writeMemory(root, 'dir/b.md', '2')
    removeMemory(root, 'dir', true)
    expect(listMemories(root)).toBe('(empty)')
    expect(() => removeMemory(root, 'dir')).toThrow(/No such/)
  })
})
