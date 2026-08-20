/**
 * WP 1.8 — input state machine and the DOM binding.
 *
 * The DOM half is tested against a hand-rolled fake canvas/document built on Node's
 * `EventTarget` rather than jsdom (no new dependencies, spec rule D). What is being checked
 * is the logic that actually goes wrong in practice: look deltas leaking while the pointer
 * is unlocked, and keys sticking down after focus loss.
 */

import { describe, expect, it } from 'vitest'
import { CameraInput, DEFAULT_INPUT_CONFIG, DomInputBinding } from '../../src/camera/input.ts'

describe('CameraInput', () => {
  it('resolves opposing keys to zero and reports axes in [-1, 1]', () => {
    const i = new CameraInput()
    i.setKey('KeyW', true)
    expect(i.consume().moveForward).toBe(1)
    i.setKey('KeyS', true)
    expect(i.consume().moveForward).toBe(0)
    i.setKey('KeyW', false)
    expect(i.consume().moveForward).toBe(-1)
    i.setKey('KeyD', true)
    const s = i.consume()
    expect(s.moveRight).toBe(1)
    expect(s.moveForward).toBe(-1)
  })

  it('applies look sensitivity and inverts Y by default (screen down = look down)', () => {
    const i = new CameraInput({ lookSensitivityRadPerPx: 0.01 })
    i.addLookPixels(100, 50)
    const s = i.consume()
    expect(s.lookYaw).toBeCloseTo(1.0, 12) // right on screen = clockwise yaw
    expect(s.lookPitch).toBeCloseTo(-0.5, 12) // down on screen = pitch down
    const inv = new CameraInput({ lookSensitivityRadPerPx: 0.01, invertY: true })
    inv.addLookPixels(0, 50)
    expect(inv.consume().lookPitch).toBeCloseTo(0.5, 12)
  })

  it('accumulates between reads and zeroes on read', () => {
    const i = new CameraInput()
    i.addLookRadians(0.1, 0.2)
    i.addLookRadians(0.1, -0.1)
    i.addScroll(2)
    i.addScroll(-1)
    const s = i.consume()
    expect(s.lookYaw).toBeCloseTo(0.2, 12)
    expect(s.lookPitch).toBeCloseTo(0.1, 12)
    expect(s.scroll).toBe(1)
    const s2 = i.consume()
    expect(s2.lookYaw).toBe(0)
    expect(s2.scroll).toBe(0)
  })

  it('reports the mode toggle exactly once per physical press', () => {
    const i = new CameraInput()
    i.setKey('KeyF', true)
    expect(i.consume().toggleMode).toBe(true)
    i.setKey('KeyF', true) // auto-repeat
    expect(i.consume().toggleMode).toBe(false)
    i.setKey('KeyF', false)
    i.setKey('KeyF', true)
    expect(i.consume().toggleMode).toBe(true)
  })

  it('clear() releases everything, so focus loss cannot leave a key stuck down', () => {
    const i = new CameraInput()
    i.setKey('KeyW', true)
    i.addLookRadians(1, 1)
    i.clear()
    const s = i.consume()
    expect(s.moveForward).toBe(0)
    expect(s.lookYaw).toBe(0)
    expect(i.isDown('KeyW')).toBe(false)
  })

  it('uses KeyboardEvent.code bindings, so it works on non-QWERTY layouts', () => {
    // 'KeyW' is the physical key position; on AZERTY that key produces 'z' but still
    // reports code 'KeyW'. Binding on `key` instead would silently break those users.
    expect(DEFAULT_INPUT_CONFIG.bindings.forward).toContain('KeyW')
    expect(DEFAULT_INPUT_CONFIG.bindings.sprint).toContain('ShiftLeft')
  })
})

// ---------------------------------------------------------------------------
// Minimal fake DOM. Only the surface DomInputBinding actually touches.
// ---------------------------------------------------------------------------

class FakeDoc extends EventTarget {
  pointerLockElement: unknown = null
  defaultView: EventTarget = new EventTarget()
  exitCalls = 0
  exitPointerLock(): void {
    this.exitCalls++
    this.pointerLockElement = null
  }
}

const makeFakeCanvas = (): { canvas: HTMLCanvasElement; doc: FakeDoc; lockRequests: number } => {
  const doc = new FakeDoc()
  const target = new EventTarget() as EventTarget & Record<string, unknown>
  const box = { lockRequests: 0 }
  Object.assign(target, {
    ownerDocument: doc,
    width: 1920,
    height: 1080,
    requestPointerLock: (): Promise<void> => {
      box.lockRequests++
      return Promise.resolve()
    },
    exitPointerLock: (): void => undefined,
  })
  const canvas = target as unknown as HTMLCanvasElement
  return {
    canvas,
    doc,
    get lockRequests(): number {
      return box.lockRequests
    },
  } as { canvas: HTMLCanvasElement; doc: FakeDoc; lockRequests: number }
}

const key = (type: string, code: string): Event => {
  const ev = new Event(type)
  Object.assign(ev, { code, repeat: false, preventDefault: (): void => undefined })
  return ev
}

const mouseMove = (dx: number, dy: number): Event => {
  const ev = new Event('mousemove')
  Object.assign(ev, { movementX: dx, movementY: dy })
  return ev
}

describe('DomInputBinding', () => {
  it('ignores look deltas until the pointer is locked', () => {
    const input = new CameraInput({ lookSensitivityRadPerPx: 1 })
    const binding = new DomInputBinding(input)
    const fake = makeFakeCanvas()
    binding.attach(fake.canvas)

    fake.doc.dispatchEvent(mouseMove(10, 0))
    expect(input.consume().lookYaw).toBe(0)
    expect(binding.isLocked).toBe(false)

    // The click handler asks for pointer lock; the browser confirms via pointerlockchange.
    fake.canvas.dispatchEvent(new Event('click'))
    fake.doc.pointerLockElement = fake.canvas
    fake.doc.dispatchEvent(new Event('pointerlockchange'))
    expect(binding.isLocked).toBe(true)

    fake.doc.dispatchEvent(mouseMove(10, 0))
    expect(input.consume().lookYaw).toBeCloseTo(10, 9)

    // Detaching while locked must release the pointer, or the user is trapped in a canvas
    // that is no longer listening to them.
    binding.detach()
    expect(fake.doc.exitCalls).toBe(1)
    expect(binding.isLocked).toBe(false)
  })

  it('releases held keys when the pointer unlocks or the window blurs', () => {
    const input = new CameraInput()
    const binding = new DomInputBinding(input)
    const fake = makeFakeCanvas()
    binding.attach(fake.canvas)
    const win = fake.doc.defaultView

    win.dispatchEvent(key('keydown', 'KeyW'))
    expect(input.consume().moveForward).toBe(1)
    win.dispatchEvent(new Event('blur'))
    expect(input.consume().moveForward).toBe(0)

    win.dispatchEvent(key('keydown', 'KeyW'))
    expect(input.consume().moveForward).toBe(1)
    fake.doc.pointerLockElement = null
    fake.doc.dispatchEvent(new Event('pointerlockchange'))
    expect(input.consume().moveForward).toBe(0)
    binding.detach()
  })

  it('removes every listener on detach', () => {
    const input = new CameraInput()
    const binding = new DomInputBinding(input)
    const fake = makeFakeCanvas()
    binding.attach(fake.canvas)
    binding.detach()
    fake.doc.defaultView.dispatchEvent(key('keydown', 'KeyW'))
    expect(input.consume().moveForward).toBe(0)
  })

  it('keyup still arrives for keys pressed before detach/reattach', () => {
    const input = new CameraInput()
    const binding = new DomInputBinding(input)
    const fake = makeFakeCanvas()
    binding.attach(fake.canvas)
    binding.attach(fake.canvas) // re-attach must not double-register
    const win = fake.doc.defaultView
    win.dispatchEvent(key('keydown', 'KeyD'))
    expect(input.consume().moveRight).toBe(1)
    win.dispatchEvent(key('keyup', 'KeyD'))
    expect(input.consume().moveRight).toBe(0)
    binding.detach()
  })
})
