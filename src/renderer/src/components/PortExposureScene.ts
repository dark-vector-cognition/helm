import * as pc from 'playcanvas'
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs'
import {
  connectionTotal,
  localServiceGrid,
  type BindReach,
  type ExposedService,
  type SavedCamera
} from '../stores/port-exposure'

// Scene units are metres. The slab is "this Mac"; its raised rim is the machine boundary.
const SLAB = 1.1
const SLAB_TOP = 0.06
const RIM_HEIGHT = 0.1
const FOCUS = new pc.Vec3(0, SLAB_TOP, 0)
export const DEFAULT_CAMERA: SavedCamera = { yaw: 35, pitch: -36, distance: 2.2 }
// Exposed rings sit clear of the slab corners (0.78 m from centre).
const RING: Record<BindReach, number> = { local: 0.3, interface: 0.88, all: 1.05 }

export interface SceneCallbacks {
  onSelect: (key: string | null) => void
  onViewSettled: (camera: SavedCamera) => void
  onLabel: (label: { x: number; y: number } | null) => void
  onLost: (reason: string) => void
}

function cssColor(el: Element, name: string, fallback: string): pc.Color {
  const raw = getComputedStyle(el).getPropertyValue(name).trim() || fallback
  const hex = /^#([0-9a-f]{6})$/i.test(raw) ? raw : fallback
  const n = parseInt(hex.slice(1), 16)
  return new pc.Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function material(diffuse: pc.Color, gloss: number, metalness = 0): pc.StandardMaterial {
  const m = new pc.StandardMaterial()
  m.diffuse = diffuse
  m.gloss = gloss
  m.useMetalness = true
  m.metalness = metalness
  m.update()
  return m
}

export function poseFromCamera(view: SavedCamera): pc.Vec3 {
  const yaw = (view.yaw * Math.PI) / 180
  const pitch = (view.pitch * Math.PI) / 180
  const flat = view.distance * Math.cos(pitch)
  return new pc.Vec3(
    FOCUS.x + flat * Math.sin(yaw),
    FOCUS.y - view.distance * Math.sin(pitch),
    FOCUS.z + flat * Math.cos(yaw)
  )
}

function cameraFromPose(position: pc.Vec3): SavedCamera {
  const offset = position.clone().sub(FOCUS)
  const distance = Math.max(0.0001, offset.length())
  return {
    yaw: (Math.atan2(offset.x, offset.z) * 180) / Math.PI,
    pitch: -(Math.asin(Math.min(1, Math.max(-1, offset.y / distance))) * 180) / Math.PI,
    distance
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Service'
}

export class PortExposureScene {
  private readonly app: pc.AppBase
  private readonly camera: pc.Entity
  private readonly controls: CameraControls
  private readonly services: pc.Entity
  private readonly entities = new Map<string, { entity: pc.Entity; top: number }>()
  private readonly materials: Record<BindReach | 'selected', pc.StandardMaterial>
  private readonly cleanups: Array<() => void> = []
  private selectedKey: string | null = null
  private visible = true
  private lastPose = new pc.Vec3(Infinity, 0, 0)
  private settleTimer = 0
  private dirtyFrames = 2
  // The view a button or key step is easing toward; steps build on it, not on a mid-ease pose.
  private target: SavedCamera | null = null
  private disposed = false

  static async create(
    canvas: HTMLCanvasElement,
    callbacks: SceneCallbacks,
    initial: SavedCamera | null,
    reducedMotion: boolean
  ): Promise<PortExposureScene> {
    const device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: [pc.DEVICETYPE_WEBGL2],
      antialias: true,
      alpha: false
    })
    return new PortExposureScene(canvas, device, callbacks, initial, reducedMotion)
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    device: pc.GraphicsDevice,
    private readonly callbacks: SceneCallbacks,
    initial: SavedCamera | null,
    reducedMotion: boolean
  ) {
    device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const options = new pc.AppOptions()
    options.devtools = false
    options.graphicsDevice = device
    options.componentSystems = [
      pc.RenderComponentSystem,
      pc.CameraComponentSystem,
      pc.LightComponentSystem,
      pc.ScriptComponentSystem
    ]
    options.resourceHandlers = []
    const app = new pc.AppBase(canvas)
    app.init(options)
    app.setCanvasFillMode(pc.FILLMODE_NONE)
    app.setCanvasResolution(pc.RESOLUTION_AUTO)
    app.autoRender = false
    this.app = app

    this.services = new pc.Entity('Services', app)

    const bg = cssColor(canvas, '--helm-well-bg', '#121413')
    const panel = cssColor(canvas, '--helm-panel-bg', '#191c1a')
    const rim = cssColor(canvas, '--helm-control-border', '#3c463e')
    const muted = cssColor(canvas, '--helm-shell-subtle', '#879087')
    const warm = cssColor(canvas, '--helm-accent-warm', '#f2c68d')
    const accent = cssColor(canvas, '--helm-accent', '#d8ef8a')
    const warmDim = new pc.Color(warm.r * 0.72, warm.g * 0.72, warm.b * 0.72)

    this.materials = {
      local: material(muted, 0.45),
      interface: material(warmDim, 0.5),
      all: material(warm, 0.55),
      selected: material(accent, 0.6)
    }
    this.materials.selected.emissive = new pc.Color(accent.r * 0.25, accent.g * 0.25, accent.b * 0.25)
    this.materials.selected.update()

    app.scene.ambientLight = new pc.Color(0.16, 0.17, 0.16)
    app.scene.exposure = 1.1

    const root = new pc.Entity('PortExposure', app)
    app.root.addChild(root)

    const floor = new pc.Entity('Floor', app)
    floor.addComponent('render', { type: 'cylinder', material: material(new pc.Color(bg.r * 1.25, bg.g * 1.25, bg.b * 1.25), 0.2) })
    floor.setLocalScale(4.6, 0.02, 4.6)
    floor.setLocalPosition(0, -0.01, 0)
    root.addChild(floor)

    const machine = new pc.Entity('Machine', app)
    machine.addComponent('render', { type: 'box', material: material(new pc.Color(panel.r * 1.35, panel.g * 1.35, panel.b * 1.35), 0.4, 0.1) })
    machine.setLocalScale(SLAB, SLAB_TOP, SLAB)
    machine.setLocalPosition(0, SLAB_TOP / 2, 0)
    root.addChild(machine)

    const boundary = new pc.Entity('Boundary', app)
    root.addChild(boundary)
    const rimMaterial = material(rim, 0.5, 0.2)
    const t = 0.025
    const sides: Array<[string, number, number, number, number]> = [
      ['North', 0, -SLAB / 2, SLAB, t],
      ['South', 0, SLAB / 2, SLAB, t],
      ['East', SLAB / 2, 0, t, SLAB],
      ['West', -SLAB / 2, 0, t, SLAB]
    ]
    for (const [name, x, z, sx, sz] of sides) {
      const wall = new pc.Entity(name, app)
      wall.addComponent('render', { type: 'box', material: rimMaterial })
      wall.setLocalScale(sx, RIM_HEIGHT, sz)
      wall.setLocalPosition(x, SLAB_TOP + RIM_HEIGHT / 2, z)
      boundary.addChild(wall)
    }
    root.addChild(this.services)

    const key = new pc.Entity('KeyLight', app)
    key.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1, 0.97, 0.92),
      intensity: 1.6,
      castShadows: true,
      shadowResolution: 2048,
      shadowDistance: 6,
      shadowBias: 0.2,
      normalOffsetBias: 0.05
    })
    key.setLocalEulerAngles(52, 30, 0)
    root.addChild(key)

    this.camera = new pc.Entity('Camera', app)
    this.camera.addComponent('camera', {
      fov: 40,
      clearColor: bg,
      nearClip: 0.05,
      farClip: 40
    })
    this.camera.addComponent('script')
    root.addChild(this.camera)
    const start = initial ?? DEFAULT_CAMERA
    this.camera.setPosition(poseFromCamera(start))
    this.camera.lookAt(FOCUS)
    this.controls = this.camera.script!.create(CameraControls) as CameraControls
    this.controls.enableFly = false
    this.controls.enablePan = false
    this.controls.pitchRange = new pc.Vec2(-85, -8)
    this.controls.zoomRange = new pc.Vec2(0.9, 6)
    const damping = reducedMotion ? 0 : 0.95
    this.controls.rotateDamping = damping
    this.controls.zoomDamping = damping
    this.controls.focusDamping = reducedMotion ? 0 : 0.9
    this.controls.reset(FOCUS, poseFromCamera(start))

    app.on('update', this.onUpdate, this)
    this.bindInput()
    this.resize()
    app.start()
  }

  // Register only the mounted sample scene and release it when the preview closes.
  registerInspector(): void {
    const inspector = (globalThis as Record<symbol, {
      register?: (...args: unknown[]) => void
      unregister?: (app: pc.AppBase) => void
    } | undefined>)[
      Symbol.for('playcanvas.inspector')
    ]
    inspector?.register?.(this.app, { version: pc.version, revision: pc.revision, protocol: 1, pc })
    this.app.once('destroy', () => inspector?.unregister?.(this.app))
  }

  private bindInput(): void {
    const canvas = this.canvas
    let down: { x: number; y: number } | null = null
    // Canvas-relative point from client coordinates; offsetX is not reliable for every input source.
    const point = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const onDown = (event: PointerEvent): void => {
      down = point(event)
      this.target = null
      this.dirtyFrames = 2
    }
    const onUp = (event: PointerEvent): void => {
      if (!down) return
      const up = point(event)
      const moved = Math.hypot(up.x - down.x, up.y - down.y)
      down = null
      if (moved < 6) this.pick(up.x, up.y)
    }
    const onWheel = (): void => {
      this.target = null
      this.dirtyFrames = 2
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: true })

    const resizeObserver = new ResizeObserver(() => this.resize())
    resizeObserver.observe(canvas)
    const visibilityObserver = new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting) && !document.hidden
      this.dirtyFrames = 2
    })
    visibilityObserver.observe(canvas)
    const onVisibility = (): void => {
      this.visible = !document.hidden
      this.dirtyFrames = 2
    }
    document.addEventListener('visibilitychange', onVisibility)
    const onLost = (): void => this.callbacks.onLost('The graphics device was lost.')
    this.app.graphicsDevice.on('devicelost', onLost)

    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      resizeObserver.disconnect()
      visibilityObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      this.app.graphicsDevice.off('devicelost', onLost)
    })
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.canvas
    if (clientWidth > 0 && clientHeight > 0) {
      this.app.resizeCanvas(clientWidth, clientHeight)
      // A tall canvas (phone width) needs a wider vertical fov to keep the whole slab in frame.
      const aspect = clientWidth / clientHeight
      const half = (20 * Math.PI) / 180
      this.camera.camera!.fov =
        aspect < 1.6 ? Math.min(70, (2 * Math.atan((Math.tan(half) * 1.6) / aspect) * 180) / Math.PI) : 40
    }
    this.dirtyFrames = 2
  }

  private pick(x: number, y: number): void {
    const cam = this.camera.camera!
    const from = cam.screenToWorld(x, y, cam.nearClip)
    const to = cam.screenToWorld(x, y, cam.farClip)
    const ray = new pc.Ray(from, to.clone().sub(from).normalize())
    const hit = new pc.Vec3()
    let best: { key: string; distance: number } | null = null
    for (const [key, { entity }] of this.entities) {
      const mesh = entity.render?.meshInstances[0]
      if (mesh && mesh.aabb.intersectsRay(ray, hit)) {
        const distance = hit.distance(from)
        if (!best || distance < best.distance) best = { key, distance }
      }
    }
    this.callbacks.onSelect(best ? best.key : null)
  }

  // Render only while something changes and the canvas is on screen.
  private onUpdate(dt: number): void {
    if (this.disposed) return
    const pose = this.camera.getPosition()
    const moving = !pose.equalsApprox(this.lastPose, 1e-5)
    if (moving) {
      this.lastPose.copy(pose)
      this.settleTimer = 0.4
      this.dirtyFrames = Math.max(this.dirtyFrames, 1)
    } else if (this.settleTimer > 0) {
      this.settleTimer -= dt
      if (this.settleTimer <= 0) {
        this.target = null
        this.callbacks.onViewSettled(cameraFromPose(pose))
      }
    }
    if (this.visible && this.dirtyFrames > 0) {
      this.dirtyFrames -= 1
      this.app.renderNextFrame = true
      this.emitLabel()
    }
  }

  private emitLabel(): void {
    const target = this.selectedKey ? this.entities.get(this.selectedKey) : undefined
    if (!target) {
      this.callbacks.onLabel(null)
      return
    }
    const top = target.entity.getPosition().clone()
    top.y = target.top + 0.04
    const screen = this.camera.camera!.worldToScreen(top)
    this.callbacks.onLabel(screen.z > 0 ? { x: screen.x, y: screen.y } : null)
  }

  setServices(services: ExposedService[], selectedKey: string | null): void {
    // Sparse local services share the inner ring. Exposed services share one angular sequence
    // so a one-address service does not line up with an all-interfaces one.
    const group = (s: ExposedService): 'local' | 'exposed' => (s.reach === 'local' ? 'local' : 'exposed')
    const counts = { local: 0, exposed: 0 }
    for (const s of services) counts[group(s)] += 1
    const index = { local: 0, exposed: 0 }
    const seen = new Set<string>()

    for (const service of services) {
      seen.add(service.key)
      const i = index[group(service)]++
      const n = counts[group(service)]
      const grid = service.reach === 'local' && n > 10 ? localServiceGrid(i, n) : null
      const angle = ((i + 0.5) / n) * Math.PI * 2 + Math.PI / 5
      const radius = RING[service.reach]
      const height = 0.08 + 0.06 * Math.log2(1 + connectionTotal(service))
      const base = service.reach === 'local' ? SLAB_TOP : 0
      const selected = service.key === selectedKey

      let record = this.entities.get(service.key)
      if (!record) {
        const prefix = service.reach === 'local' ? 'Local' : 'Exposed'
        const entity = new pc.Entity(`${prefix}-${service.port}-${slug(service.process)}`, this.app)
        entity.addComponent('render', {
          type: service.reach === 'local' ? 'box' : 'cylinder',
          castShadows: true
        })
        this.services.addChild(entity)
        record = { entity, top: 0 }
        this.entities.set(service.key, record)
      }
      const width = (selected ? 0.09 : 0.07) * (grid?.scale ?? 1)
      record.entity.render!.type = service.reach === 'local' ? 'box' : 'cylinder'
      record.entity.render!.material = selected ? this.materials.selected : this.materials[service.reach]
      record.entity.setLocalScale(width, height, width)
      record.entity.setLocalPosition(
        grid?.x ?? Math.sin(angle) * radius,
        base + height / 2,
        grid?.z ?? Math.cos(angle) * radius
      )
      record.top = base + height
    }

    for (const [key, record] of this.entities) {
      if (!seen.has(key)) {
        record.entity.destroy()
        this.entities.delete(key)
      }
    }
    this.selectedKey = selectedKey
    this.dirtyFrames = 2
  }

  private currentView(): SavedCamera {
    return this.target ?? cameraFromPose(this.camera.getPosition())
  }

  private applyView(view: SavedCamera): void {
    const clamped: SavedCamera = {
      yaw: view.yaw,
      pitch: Math.min(-8, Math.max(-85, view.pitch)),
      distance: Math.min(6, Math.max(0.9, view.distance))
    }
    this.target = clamped
    this.controls.reset(FOCUS, poseFromCamera(clamped))
    this.dirtyFrames = 2
  }

  rotate(degrees: number): void {
    const view = this.currentView()
    this.applyView({ ...view, yaw: view.yaw + degrees })
  }

  tilt(degrees: number): void {
    const view = this.currentView()
    this.applyView({ ...view, pitch: view.pitch + degrees })
  }

  zoom(factor: number): void {
    const view = this.currentView()
    this.applyView({ ...view, distance: view.distance * factor })
  }

  resetView(): void {
    this.applyView(DEFAULT_CAMERA)
  }

  focusService(key: string): void {
    const record = this.entities.get(key)
    if (!record) return
    const p = record.entity.getPosition()
    const view = this.currentView()
    // Turn the camera so the selected service faces the viewer; keep tilt, and back off
    // far enough that a near-side service stays inside the frame.
    this.applyView({
      ...view,
      yaw: (Math.atan2(p.x, p.z) * 180) / Math.PI,
      distance: Math.max(view.distance, DEFAULT_CAMERA.distance)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cleanup of this.cleanups) cleanup()
    this.app.off('update', this.onUpdate, this)
    this.app.destroy()
  }
}
