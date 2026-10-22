/**
 * Removes `usocket`, dbus-next's optional native helper.
 *
 * `usocket` is an optionalDependency of `dbus-next` whose node-gyp addon is built against
 * the host Node ABI. Loading it inside Electron's V8 sandbox aborts the whole main process:
 *
 *   Fatal error in V8: v8_ArrayBuffer_NewBackingStore ... must be allocated inside the
 *   sandbox address space
 *   SIGSEGV -> systemd-coredump -> ~20 GB of disk churn -> the disk fills up
 *
 * dbus-next only uses it for abstract sockets and unix FD passing, wraps `require` in
 * try/catch, and falls back to a plain `net` socket, so removing it costs nothing the
 * app's XDG portal calls need.
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname } from 'node:path'

const require = createRequire(import.meta.url)

let target
try {
  target = dirname(require.resolve('usocket/package.json'))
} catch {
  process.exit(0) // not installed: nothing to do
}

// Never delete anything that is not the addon's own directory.
if (basename(target) !== 'usocket') {
  console.warn(`[postinstall] unexpected usocket path "${target}"; leaving it alone`)
  process.exit(0)
}

try {
  rmSync(target, { recursive: true, force: true })
  console.log('[postinstall] removed usocket: its node-gyp addon crashes Electron 39 (V8 sandbox)')
} catch (error) {
  console.warn('[postinstall] could not remove usocket:', error.message)
}
