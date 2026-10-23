import { randomBytes } from 'crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'

function tempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * Write a file by creating a sibling temp file and renaming it into place, so a
 * crash mid-write can never leave a truncated config or conversation behind.
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = tempPath(filePath)
  try {
    writeFileSync(tmp, data, 'utf-8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = tempPath(filePath)
  try {
    await writeFile(tmp, data, 'utf-8')
    await rename(tmp, filePath)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}
