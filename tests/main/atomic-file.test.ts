import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic, writeFileAtomicSync } from '../../src/main/services/atomic-file'

describe('atomic file writes', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delta-ai-atomic-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  for (const [name, write] of [
    ['writeFileAtomicSync', async (p: string, d: string) => writeFileAtomicSync(p, d)],
    ['writeFileAtomic', writeFileAtomic]
  ] as const) {
    describe(name, () => {
      it('creates missing parent directories and writes the content', async () => {
        const target = join(dir, 'nested', 'deeper', 'file.json')
        await write(target, '{"a":1}')
        expect(readFileSync(target, 'utf-8')).toBe('{"a":1}')
      })

      it('replaces an existing file and leaves no temp files behind', async () => {
        const target = join(dir, 'file.json')
        await write(target, 'old')
        await write(target, 'new')
        expect(readFileSync(target, 'utf-8')).toBe('new')
        expect(readdirSync(dir)).toEqual(['file.json'])
      })

      it('keeps the previous file and cleans up its temp file when the rename fails', async () => {
        // A directory at the target path makes the rename fail after the temp write.
        const target = join(dir, 'occupied')
        mkdirSync(target)
        await expect(write(target, 'data')).rejects.toThrow()
        expect(existsSync(target)).toBe(true)
        expect(readdirSync(dir)).toEqual(['occupied'])
      })
    })
  }
})
