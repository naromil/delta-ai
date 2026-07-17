/**
 * Freedesktop `org.freedesktop.portal.Screenshot` routing for screen capture
 * on KDE Plasma Wayland.
 *
 * Why this exists:
 * On native Wayland, Electron's `desktopCapturer.getSources()` routes through
 * the `org.freedesktop.portal.ScreenCast` interface. On KDE Plasma Wayland
 * that portal shows a "Choose what to share" prompt on every call, and KDE's
 * "remember my choice" checkbox is broken (the permission is dropped between
 * ScreenCast sessions, pending a longstanding xdg-desktop-portal-kde fix).
 *
 * For single-frame screen-grab use cases (like delta-ai's OCR captured region)
 * we do not need a live stream — we need one still image. The Freedesktop
 * `Screenshot` portal handles that with `interactive=false`, which on KDE
 * captures the active monitor silently with no persistent prompt (after the
 * initial one-time consent, KDE canonicalises the application as trusted for
 * non-interactive screenshots thereafter).
 *
 * The module mirrors the structure of `globalShortcutPortal.ts` and reuses the
 * same `Request.Response` signal protocol — a one-shot per-call request handle
 * whose `Response` signal carries the results dict.
 */
import { sessionBus, Variant, Message, MessageBus } from 'dbus-next'
import { readFileSync, unlinkSync } from 'fs'
import { URL } from 'url'
import { isKdeWaylandSession } from '../config'

const PORTAL_DEST = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const PORTAL_IFACE = 'org.freedesktop.portal.Screenshot'
const REQUEST_IFACE = 'org.freedesktop.portal.Request'

let bus: MessageBus | null = null
const pendingRequests = new Map<string, (results: Record<string, unknown>) => void>()

function randToken(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function addMatch(match: string): Promise<void> {
  const msg = new Message({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'AddMatch',
    signature: 's',
    body: [match]
  })
  await (bus as MessageBus).call(msg)
}

async function ensureBus(): Promise<MessageBus> {
  if (!bus) {
    bus = sessionBus()
    // Pre-register the match for the portal's `Response` signal so we receive
    // it even if the signal fires before our per-request listener is installed
    // (otherwise we lose the race and the request hangs).
    await addMatch(
      `type='signal',sender='${PORTAL_DEST}',interface='${REQUEST_IFACE}',member='Response'`
    )
    bus.on('message', (msg: Message) => {
      if (msg.interface === REQUEST_IFACE && msg.member === 'Response' && msg.path) {
        const resolve = pendingRequests.get(msg.path)
        if (resolve) {
          pendingRequests.delete(msg.path)
          resolve((msg.body[1] as Record<string, unknown>) ?? {})
        }
      }
    })
  }
  return bus
}

async function callPortalMethod(
  member: string,
  signature: string,
  body: unknown[]
): Promise<string> {
  const b = await ensureBus()
  const msg = new Message({
    destination: PORTAL_DEST,
    path: PORTAL_PATH,
    interface: PORTAL_IFACE,
    member,
    signature,
    body
  })
  const reply = (await b.call(msg)) as Message
  return reply.body[0] as string
}

function waitResponse(requestPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    pendingRequests.set(requestPath, resolve)
  })
}

async function portalRequest(
  member: string,
  signature: string,
  args: unknown[]
): Promise<Record<string, unknown>> {
  const requestPath = await callPortalMethod(member, signature, args)
  return waitResponse(requestPath)
}

/**
 * Capture a single full-screen snapshot via the Freedesktop Screenshot portal.
 *
 * On KDE Plasma Wayland with `interactive: false`, this avoids the persistent
 * "Choose what to share" desktop-sharing prompt that the ScreenCast-backed
 * `desktopCapturer` shows on every call (and whose "remember choice" checkbox
 * is broken at the portal impl level).
 *
 * Returns the screenshot as a PNG `Buffer`, or `null` if the user dismissed the
 * one-time consent dialog or no URI was returned.
 */
export async function captureScreenViaPortal(): Promise<Buffer | null> {
  try {
    await ensureBus()

    const results = await portalRequest('Screenshot', 'sa{sv}', [
      '', // parent_window — empty; portal has no real window to attach to
      {
        handle_token: new Variant('s', randToken()),
        interactive: new Variant('b', false),
        // Hint that we want a full monitor capture (KDE portal v2 ignores
        // unknown options safely).
        mode: new Variant('s', 'fullscreen')
      }
    ])

    // Response results: { uri: 'file:///tmp/...' }
    const uriVariant = results['uri']
    let uriValue: string | undefined
    if (uriVariant instanceof Variant) {
      uriValue = uriVariant.value as string
    } else if (typeof uriVariant === 'string') {
      uriValue = uriVariant
    }

    if (!uriValue) {
      // User dismissed the one-time consent dialog, or capture was cancelled.
      return null
    }

    let localPath = uriValue
    if (uriValue.startsWith('file://')) {
      try {
        localPath = new URL(uriValue).pathname
      } catch {
        localPath = uriValue.slice('file://'.length)
      }
    }
    localPath = decodeURIComponent(localPath)

    const buffer = readFileSync(localPath)
    try {
      unlinkSync(localPath)
    } catch {
      // best-effort cleanup of portal temp file; non-fatal
    }
    return buffer
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`Screenshot portal capture failed: ${msg}`)
    return null
  }
}

/**
 * Whether the Screenshot portal path is worth trying in this session.
 * Confined to KDE + Wayland for now, per user request; on other compositors
 * the Screenshot portal may behave differently, so we keep the desktopCapturer
 * path as the default there.
 */
export function isScreenCapturePortalPreferred(): boolean {
  return isKdeWaylandSession()
}
