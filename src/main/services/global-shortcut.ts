/**
 * XDG Desktop Portal GlobalShortcuts routing for native Wayland.
 *
 * On a native Wayland session (KDE Plasma, GNOME) Electron's `globalShortcut`
 * cannot bind keys via X11/XTest, so it silently fails. The robust
 * cross-desktop fix is to talk to `org.freedesktop.portal.GlobalShortcuts`
 * directly over D-Bus: create a session, bind the accelerator, and listen for
 * the portal's `Activated` signal (the matching session handle is the first
 * field of the `osta{sv}` body).
 */
import { sessionBus, Variant, Message, MessageBus } from 'dbus-next'

const PORTAL_DEST = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const PORTAL_IFACE = 'org.freedesktop.portal.GlobalShortcuts'
const REQUEST_IFACE = 'org.freedesktop.portal.Request'
const SHORTCUT_ID = 'delta-ai-trigger'

let bus: MessageBus | null = null
let sessionHandle: string | null = null
let onActivatedCb: (() => void) | null = null
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
    // Pre-register a match for the portal's `Response` signals so they reach us
    // even if the signal fires before the per-request listener is installed
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
      } else if (
        msg.interface === PORTAL_IFACE &&
        msg.member === 'Activated' &&
        msg.path === PORTAL_PATH
      ) {
        // body: [o session_handle, s shortcut_id, t timestamp, a{sv} options]
        const handle = msg.body[0] as string
        const id = msg.body[1] as string
        if (sessionHandle && handle === sessionHandle && id === SHORTCUT_ID && onActivatedCb) {
          onActivatedCb()
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

/** Resolve once the portal emits `Response` on the given request object. */
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

async function closeSession(): Promise<void> {
  if (sessionHandle && bus) {
    try {
      const msg = new Message({
        destination: PORTAL_DEST,
        path: sessionHandle,
        interface: 'org.freedesktop.portal.Session',
        member: 'Close',
        signature: '',
        body: []
      })
      await bus.call(msg)
    } catch {
      // best effort
    }
    sessionHandle = null
  }
}

/** Convert an Electron accelerator (e.g. `Ctrl+Shift+D`) to a GTK accel string. */
function electronToGtkAccel(accelerator: string): string {
  const parts = accelerator.split('+')
  const mods: string[] = []
  let key = ''
  for (const part of parts) {
    switch (part) {
      case 'Ctrl':
      case 'Control':
      case 'CommandOrControl':
        mods.push('<Control>')
        break
      case 'Alt':
      case 'Option':
        mods.push('<Alt>')
        break
      case 'Shift':
        mods.push('<Shift>')
        break
      case 'Cmd':
      case 'Command':
      case 'Super':
      case 'Meta':
        mods.push('<Mod4>')
        break
      default:
        key = part
    }
  }
  return mods.join('') + gtkKeyName(key)
}

function gtkKeyName(key: string): string {
  const map: Record<string, string> = {
    Space: 'space',
    Enter: 'Return',
    Return: 'Return',
    Esc: 'Escape',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'BackSpace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'Page_Up',
    PageDown: 'Page_Down',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
    Plus: 'plus',
    Minus: 'minus',
    Equal: 'equal',
    Backquote: 'grave',
    CapsLock: 'Caps_Lock'
  }
  if (map[key]) return map[key]
  if (/^F\d{1,2}$/.test(key)) return key
  if (key.length === 1) return key.toUpperCase()
  return key
}

/**
 * Register the global shortcut through the XDG GlobalShortcuts portal.
 * Returns true if the portal accepted and assigned the trigger.
 */
export async function registerGlobalShortcutPortal(
  accelerator: string,
  onActivated: () => void
): Promise<boolean> {
  try {
    onActivatedCb = onActivated
    await closeSession()
    await ensureBus()

    const createResults = await portalRequest('CreateSession', 'a{sv}', [
      {
        handle_token: new Variant('s', randToken()),
        session_handle_token: new Variant('s', randToken())
      }
    ])
    sessionHandle = (createResults['session_handle'] as Variant).value as string

    const gtk = electronToGtkAccel(accelerator)
    const shortcuts = [
      [
        SHORTCUT_ID,
        {
          description: new Variant('s', 'Capture cursor region with Delta AI'),
          trigger: new Variant('s', gtk)
        }
      ]
    ]
    const bindResults = await portalRequest('BindShortcuts', 'oa(sa{sv})sa{sv}', [
      sessionHandle,
      shortcuts,
      '',
      {}
    ])

    const bound = bindResults['shortcuts'] as Array<[string, Record<string, Variant>]> | undefined
    const trigger = bound?.[0]?.[1]?.['trigger']?.value
    if (!bound || bound.length === 0 || trigger === '' || trigger === undefined) {
      console.warn(
        `Portal accepted "${accelerator}" (${gtk}) but assigned no trigger — ` +
          'KDE/GNOME may require you to assign it once in the desktop Global ' +
          'Shortcuts settings (look for "Delta AI"). Choose the same combo there.'
      )
      return false
    }

    console.log(`Registered global shortcut via XDG portal: ${accelerator} (${gtk})`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`Failed to register global shortcut via XDG portal: ${msg}`)
    return false
  }
}

/** Tear down the portal session (call on settings change / quit). */
export async function unregisterGlobalShortcutPortal(): Promise<void> {
  await closeSession()
  onActivatedCb = null
}
