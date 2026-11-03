import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasKeyboardActions } from '../../src/renderer/src/views/canvas/useCanvasKeyboard'
import { handleKeyDown } from '../../src/renderer/src/views/canvas/useCanvasKeyboard'

/** Every action is a spy, so a test only names the keys it cares about. */
function actionsWith(selected: string[] = []): CanvasKeyboardActions {
  const refs = {
    selectedRef: { current: new Set(selected) },
    linksRef: { current: [] },
    framesRef: { current: [] },
    viewportRef: { current: { x: 0, y: 0, zoom: 1 } },
    clearGesture: null,
    closeHelp: null,
    cancelPlacing: null,
    cancelDraft: null,
    resetTool: null
  }
  return new Proxy(refs as unknown as CanvasKeyboardActions, {
    get: (target, name, receiver) => {
      if (!(name in target)) Reflect.set(target, name, vi.fn(), receiver)
      return Reflect.get(target, name, receiver)
    }
  })
}

function press(key: string, actions: CanvasKeyboardActions): KeyboardEvent {
  const e = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: new (globalThis.Element as unknown as new () => Element)(),
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent
  handleKeyDown(e, actions)
  return e
}

describe('canvas keys', () => {
  beforeAll(() => {
    class FakeElement {
      closest(): null {
        return null
      }
    }
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('HTMLElement', FakeElement)
  })

  // Focus moves into a text field before the key has finished, so unless its default is
  // cancelled the letter is typed into that field.
  it.each([
    ['o', [], 'toggleOutline'],
    ['n', [], 'newSession'],
    ['a', ['card'], 'askAboutSelection'],
    ['Enter', [], 'compose']
  ] as const)('%s opens its text field without typing into it', (key, selected, action) => {
    const actions = actionsWith([...selected])
    const e = press(key, actions)
    expect(actions[action]).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('leaves a key alone when it is being typed into a field', () => {
    const actions = actionsWith()
    const field = new (globalThis.HTMLElement as unknown as new () => HTMLElement)()
    Object.assign(field, { isContentEditable: false, tagName: 'INPUT' })
    const e = {
      key: 'o',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: field,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent
    handleKeyDown(e, actions)
    expect(actions.toggleOutline).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
