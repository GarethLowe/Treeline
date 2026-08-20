/**
 * Camera input — WP 1.8.
 *
 * Split deliberately in two:
 *   `CameraInput`   pure state machine, no DOM. Drivable from a test with `setKey` /
 *                   `addLook` / `addScroll`, which is what makes the walker and free-camera
 *                   acceptance tests possible headless.
 *   `DomInputBinding`  wires real pointer-lock / keyboard / wheel events into it.
 *
 * Everything DOM-facing is guarded so importing this module in Node does not throw.
 */

/** One frame's worth of input, with all accumulators zeroed on read. */
export interface InputSnapshot {
  /** -1 (back) .. +1 (forward), already clamped. */
  readonly moveForward: number
  /** -1 (left) .. +1 (right). */
  readonly moveRight: number
  /** -1 (down) .. +1 (up). World up. Free mode only. */
  readonly moveUp: number
  readonly sprint: boolean
  readonly crouch: boolean
  /** Accumulated yaw change in radians, positive = turn right (clockwise from above). */
  readonly lookYaw: number
  /** Accumulated pitch change in radians, positive = look up. */
  readonly lookPitch: number
  /** Wheel notches since last read. Positive = faster / scroll up. */
  readonly scroll: number
  /** True on the frame a mode-toggle key was pressed. */
  readonly toggleMode: boolean
}

export const EMPTY_SNAPSHOT: InputSnapshot = {
  moveForward: 0,
  moveRight: 0,
  moveUp: 0,
  sprint: false,
  crouch: false,
  lookYaw: 0,
  lookPitch: 0,
  scroll: 0,
  toggleMode: false,
}

export interface InputConfig {
  /** Radians of rotation per pixel of raw pointer movement. 0.0022 ~= 0.126 deg/px. */
  readonly lookSensitivityRadPerPx: number
  readonly invertY: boolean
  /** `KeyboardEvent.code` values, so the bindings are layout-independent (AZERTY works). */
  readonly bindings: {
    readonly forward: readonly string[]
    readonly back: readonly string[]
    readonly left: readonly string[]
    readonly right: readonly string[]
    readonly up: readonly string[]
    readonly down: readonly string[]
    readonly sprint: readonly string[]
    readonly crouch: readonly string[]
    readonly toggleMode: readonly string[]
  }
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
  lookSensitivityRadPerPx: 0.0022,
  invertY: false,
  bindings: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    up: ['Space'],
    down: ['KeyC', 'ControlLeft', 'ControlRight'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    // Crouch shares the 'down' keys: in first-person there is no fly-down, so the same
    // key doing the analogous thing in each mode is one less thing to learn.
    crouch: ['KeyC', 'ControlLeft', 'ControlRight'],
    toggleMode: ['KeyF'],
  },
}

export class CameraInput {
  readonly config: InputConfig
  private readonly down = new Set<string>()
  private pendingYaw = 0
  private pendingPitch = 0
  private pendingScroll = 0
  private pendingToggle = false

  constructor(config: Partial<InputConfig> = {}) {
    this.config = {
      lookSensitivityRadPerPx:
        config.lookSensitivityRadPerPx ?? DEFAULT_INPUT_CONFIG.lookSensitivityRadPerPx,
      invertY: config.invertY ?? DEFAULT_INPUT_CONFIG.invertY,
      bindings: { ...DEFAULT_INPUT_CONFIG.bindings, ...(config.bindings ?? {}) },
    }
  }

  setKey(code: string, isDown: boolean): void {
    if (isDown) {
      if (!this.down.has(code) && this.config.bindings.toggleMode.includes(code)) {
        this.pendingToggle = true
      }
      this.down.add(code)
    } else {
      this.down.delete(code)
    }
  }

  isDown(code: string): boolean {
    return this.down.has(code)
  }

  /** Raw pointer movement in pixels, as delivered by `movementX` / `movementY`. */
  addLookPixels(dxPx: number, dyPx: number): void {
    const s = this.config.lookSensitivityRadPerPx
    this.pendingYaw += dxPx * s
    this.pendingPitch += (this.config.invertY ? dyPx : -dyPx) * s
  }

  /** Bypasses sensitivity. For tests and for scripted camera moves. */
  addLookRadians(yaw: number, pitch: number): void {
    this.pendingYaw += yaw
    this.pendingPitch += pitch
  }

  addScroll(notches: number): void {
    this.pendingScroll += notches
  }

  /** Release everything. Called on window blur and on detach so keys cannot stick down. */
  clear(): void {
    this.down.clear()
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.pendingScroll = 0
    this.pendingToggle = false
  }

  private any(codes: readonly string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true
    return false
  }

  /** Reads and resets the frame accumulators. Call exactly once per update. */
  consume(): InputSnapshot {
    const b = this.config.bindings
    const fwd = (this.any(b.forward) ? 1 : 0) - (this.any(b.back) ? 1 : 0)
    const right = (this.any(b.right) ? 1 : 0) - (this.any(b.left) ? 1 : 0)
    const up = (this.any(b.up) ? 1 : 0) - (this.any(b.down) ? 1 : 0)
    const snap: InputSnapshot = {
      moveForward: fwd,
      moveRight: right,
      moveUp: up,
      sprint: this.any(b.sprint),
      crouch: this.any(b.crouch),
      lookYaw: this.pendingYaw,
      lookPitch: this.pendingPitch,
      scroll: this.pendingScroll,
      toggleMode: this.pendingToggle,
    }
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.pendingScroll = 0
    this.pendingToggle = false
    return snap
  }
}

/**
 * Pointer-lock / keyboard / wheel binding.
 *
 * Pointer lock is requested on click rather than on load because the browser requires a
 * user gesture; `isLocked` is exposed so the HUD can show a "click to look" prompt.
 * Look deltas are ignored while unlocked, otherwise the view spins whenever the user moves
 * the mouse to reach the UI.
 */
export class DomInputBinding {
  private canvas: HTMLCanvasElement | null = null
  private locked = false
  private readonly listeners: Array<() => void> = []

  constructor(private readonly input: CameraInput) {}

  get isLocked(): boolean {
    return this.locked
  }

  attach(canvas: HTMLCanvasElement): void {
    this.detach()
    this.canvas = canvas
    const doc = canvas.ownerDocument
    const win = doc.defaultView
    if (!win) return

    const on = <K extends string>(
      target: EventTarget,
      type: K,
      handler: (ev: Event) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler, options)
      this.listeners.push(() => target.removeEventListener(type, handler, options))
    }

    on(canvas, 'click', () => {
      if (!this.locked) void canvas.requestPointerLock()
    })

    on(doc, 'pointerlockchange', () => {
      this.locked = doc.pointerLockElement === canvas
      // Releasing lock while walking must not leave the key stuck down.
      if (!this.locked) this.input.clear()
    })

    on(doc, 'mousemove', (ev) => {
      if (!this.locked) return
      const me = ev as MouseEvent
      this.input.addLookPixels(me.movementX, me.movementY)
    })

    on(win, 'keydown', (ev) => {
      const ke = ev as KeyboardEvent
      if (ke.repeat) return
      this.input.setKey(ke.code, true)
      // Space scrolls the page and Ctrl+W closes the tab; only swallow while locked so
      // browser shortcuts still work when the user is not actually driving the camera.
      if (this.locked) ke.preventDefault()
    })

    on(win, 'keyup', (ev) => {
      this.input.setKey((ev as KeyboardEvent).code, false)
    })

    on(
      canvas,
      'wheel',
      (ev) => {
        const we = ev as WheelEvent
        if (!this.locked) return
        we.preventDefault()
        // deltaY is positive when scrolling down/away; "up" should mean faster.
        this.input.addScroll(-Math.sign(we.deltaY))
      },
      { passive: false },
    )

    // A lost focus with W held would otherwise walk the camera off into the distance.
    on(win, 'blur', () => this.input.clear())
  }

  detach(): void {
    for (const off of this.listeners) off()
    this.listeners.length = 0
    this.input.clear()
    const doc = this.canvas?.ownerDocument
    if (this.locked && doc && doc.pointerLockElement === this.canvas) doc.exitPointerLock()
    this.locked = false
    this.canvas = null
  }
}
