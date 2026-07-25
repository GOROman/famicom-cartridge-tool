import * as THREE from 'three'

// Interactive drag handles for Label Recess features: 4 corner handles resize
// (opposite corner stays anchored), the center handle moves the recess.
// Handles are children of the part mesh, so they live in model space and
// follow the display transform automatically.

const HANDLE_RADIUS = 1.6
const MIN_SIZE = 4

export class RecessGizmoManager {
  constructor(viewer, { onChange, onCommit }) {
    this.viewer = viewer
    this.onChange = onChange
    this.onCommit = onCommit
    this.gizmos = new Map() // feature id -> gizmo record
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.drag = null

    const dom = viewer.renderer.domElement
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e))
    dom.addEventListener('pointerup', (e) => this.onPointerUp(e))
  }

  attach(part, feature) {
    if (this.gizmos.has(feature.id)) return
    const group = new THREE.Group()
    group.userData.isGizmo = true

    const handleGeo = new THREE.SphereGeometry(HANDLE_RADIUS, 16, 12)
    const mkMat = (color) => new THREE.MeshBasicMaterial({
      color, depthTest: false, transparent: true, opacity: 0.9,
    })
    const handles = []
    // corners: (sx, sy) in {-1,+1}; index 4 = center/move handle
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const m = new THREE.Mesh(handleGeo, mkMat(0x22aaff))
      m.userData = { isGizmo: true, sx, sy, feature, part, kind: 'corner' }
      m.renderOrder = 999
      handles.push(m)
      group.add(m)
    }
    const center = new THREE.Mesh(handleGeo, mkMat(0xffaa22))
    center.userData = { isGizmo: true, feature, part, kind: 'center' }
    center.renderOrder = 999
    handles.push(center)
    group.add(center)

    const outlineGeo = new THREE.BufferGeometry()
    outlineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3))
    const outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({
      color: 0x22aaff, depthTest: false, transparent: true, opacity: 0.8,
    }))
    outline.userData.isGizmo = true
    outline.renderOrder = 998
    group.add(outline)

    part.mesh.add(group)
    this.gizmos.set(feature.id, { part, feature, group, handles, outline })
    this.refresh(feature)
  }

  detach(feature) {
    const g = this.gizmos.get(feature.id)
    if (!g) return
    g.part.mesh.remove(g.group)
    this.gizmos.delete(feature.id)
  }

  setAllVisible(visible) {
    for (const g of this.gizmos.values()) {
      g.group.visible = visible && g.feature.enabled
    }
  }

  setVisible(feature, visible) {
    const g = this.gizmos.get(feature.id)
    if (g) g.group.visible = visible
  }

  faceZ(g) {
    const { feature: f, part } = g
    return f.face === 'Top' ? part.bounds.max.z + 0.5 : part.bounds.min.z - 0.5
  }

  refresh(feature) {
    const g = this.gizmos.get(feature.id)
    if (!g) return
    const f = g.feature
    const z = this.faceZ(g)
    const hw = f.width / 2, hh = f.height / 2
    for (const h of g.handles) {
      const { sx = 0, sy = 0 } = h.userData
      h.position.set(f.x + sx * hw, f.y + sy * hh, z)
    }
    const pos = g.outline.geometry.attributes.position
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]]
    pts.forEach(([px, py], i) => pos.setXYZ(i, f.x + px, f.y + py, z))
    pos.needsUpdate = true
  }

  setPointerFromEvent(e) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.viewer.camera)
  }

  visibleHandles() {
    return [...this.gizmos.values()]
      .filter((g) => g.group.visible && g.part.mesh.visible)
      .flatMap((g) => g.handles)
  }

  onPointerDown(e) {
    this.setPointerFromEvent(e)
    const hit = this.raycaster.intersectObjects(this.visibleHandles(), false)[0]
    if (!hit) return
    const { feature, part } = hit.object.userData
    const g = this.gizmos.get(feature.id)
    // world-space plane of the recess face, for drag raycasts
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.faceZ(g))
    plane.applyMatrix4(part.mesh.matrixWorld)
    this.drag = { handle: hit.object, g, plane }
    this.viewer.controls.enabled = false
    this.viewer.renderer.domElement.setPointerCapture(e.pointerId)
  }

  onPointerMove(e) {
    if (!this.drag) {
      // hover feedback
      this.setPointerFromEvent(e)
      const hit = this.raycaster.intersectObjects(this.visibleHandles(), false)[0]
      this.viewer.renderer.domElement.style.cursor = hit ? 'grab' : ''
      return
    }
    this.setPointerFromEvent(e)
    const world = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(this.drag.plane, world)) return
    const { g, handle } = this.drag
    const local = g.part.mesh.worldToLocal(world.clone())
    const f = g.feature
    const { kind, sx, sy } = handle.userData

    if (kind === 'center') {
      f.x = local.x
      f.y = local.y
    } else {
      // opposite corner stays fixed
      const ox = f.x - sx * f.width / 2
      const oy = f.y - sy * f.height / 2
      f.width = Math.max(MIN_SIZE, Math.abs(local.x - ox))
      f.height = Math.max(MIN_SIZE, Math.abs(local.y - oy))
      f.x = ox + sx * f.width / 2
      f.y = oy + sy * f.height / 2
    }
    this.refresh(f)
    this.onChange(g.part, f)
  }

  onPointerUp(e) {
    if (!this.drag) return
    const { g } = this.drag
    this.drag = null
    this.viewer.controls.enabled = true
    this.viewer.renderer.domElement.releasePointerCapture(e.pointerId)
    this.onCommit(g.part, g.feature)
  }
}
