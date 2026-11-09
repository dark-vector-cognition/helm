declare module 'playcanvas/scripts/esm/camera-controls.mjs' {
  import type { Script, Vec2, Vec3 } from 'playcanvas'

  export class CameraControls extends Script {
    enableFly: boolean
    enableOrbit: boolean
    enablePan: boolean
    pitchRange: Vec2
    yawRange: Vec2
    zoomRange: Vec2
    rotateDamping: number
    zoomDamping: number
    focusDamping: number
    moveDamping: number
    focus(point: Vec3, resetZoom?: boolean): void
    reset(focus: Vec3, position: Vec3): void
  }
}
