import * as THREE from 'three'

// Drafting-style measurement tool: click two points on the model to draw a
// dimension line with arrowheads and a mm label.

const COLOR = 0xffdd33

export function makeLabel(text, color = '#ffdd33', scale = 1) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const g = canvas.getContext('2d')
  g.fillStyle = 'rgba(20,20,24,0.85)'
  g.fillRect(0, 0, 256, 64)
  g.strokeStyle = color
  g.lineWidth = 3
  g.strokeRect(2, 2, 252, 60)
  g.fillStyle = color
  g.font = 'bold 30px monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 128, 34)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }))
  sprite.scale.set(24 * scale, 6 * scale, 1)
  sprite.renderOrder = 1002
  return sprite
}

export class MeasureTool {
  constructor(viewer, getTargets) {
    this.viewer = viewer
    this.getTargets = getTargets
    this.enabled = false
    this.group = new THREE.Group()
    viewer.scene.add(this.group)
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.pending = null // first click marker
    this.downPos = null

    const dom = viewer.renderer.domElement
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return
      this.downPos = [e.clientX, e.clientY]
    })
    dom.addEventListener('pointerup', (e) => {
      if (!this.enabled || !this.downPos) return
      const moved = Math.hypot(e.clientX - this.downPos[0], e.clientY - this.downPos[1])
      this.downPos = null
      if (moved > 5) return // was a camera drag
      this.onClick(e)
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancelPending()
    })
  }

  setEnabled(on) {
    this.enabled = on
    this.viewer.renderer.domElement.style.cursor = on ? 'crosshair' : ''
    if (!on) this.cancelPending()
  }

  pick(e) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.viewer.camera)
    const hit = this.raycaster.intersectObjects(this.getTargets(), false)[0]
    return hit?.point ?? null
  }

  onClick(e) {
    const p = this.pick(e)
    if (!p) return
    if (!this.pending) {
      const marker = this.makeMarker(p)
      this.group.add(marker)
      this.pending = { point: p.clone(), marker }
    } else {
      const a = this.pending.point
      this.group.remove(this.pending.marker)
      this.pending = null
      this.addDimension(a, p.clone())
    }
  }

  makeMarker(p) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 12, 8),
      new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false }))
    m.position.copy(p)
    m.renderOrder = 1001
    return m
  }

  addDimension(a, b) {
    const dim = new THREE.Group()
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    dir.normalize()

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }))
    line.renderOrder = 1000
    dim.add(line)

    // drafting arrowheads pointing inwards at both ends
    const arrowLen = Math.min(3, len * 0.25)
    for (const [tip, d] of [[a, dir], [b, dir.clone().negate()]]) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(arrowLen * 0.3, arrowLen, 10),
        new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false }))
      cone.position.copy(tip).addScaledVector(d, arrowLen / 2)
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().negate())
      cone.renderOrder = 1001
      dim.add(cone)
    }
    dim.add(this.makeMarker(a), this.makeMarker(b))

    const label = makeLabel(`${len.toFixed(2)} mm`)
    label.position.copy(a).add(b).multiplyScalar(0.5)
    label.position.y += 6
    dim.add(label)

    this.group.add(dim)
    return len
  }

  cancelPending() {
    if (this.pending) {
      this.group.remove(this.pending.marker)
      this.pending = null
    }
  }

  clear() {
    this.cancelPending()
    for (const child of [...this.group.children]) this.group.remove(child)
  }
}
