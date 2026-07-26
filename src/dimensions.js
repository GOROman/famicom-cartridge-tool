import * as THREE from 'three'
import { makeLabel } from './measure.js'

// Drafting-style automatic dimensions: width / depth / thickness of each
// part drawn with extension lines, arrowheads and mm labels, parented to
// the part mesh so they follow display transforms.

const COLOR = 0xdddddd
const OFFSET = 10 // distance of the dimension line from the part
const EXT_GAP = 1.5 // gap between part edge and extension-line start

function lineMat() {
  return new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.9 })
}

function addLine(group, a, b) {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a, b]), lineMat())
  line.renderOrder = 1000
  group.add(line)
}

function addArrow(group, tip, dir) {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.8, 2.6, 10),
    new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false }))
  cone.position.copy(tip).addScaledVector(dir, 1.3)
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate())
  cone.renderOrder = 1001
  group.add(cone)
}

function addExtensionLine(group, edge, dimPt) {
  const dir = new THREE.Vector3().subVectors(dimPt, edge).normalize()
  addLine(group,
    edge.clone().addScaledVector(dir, EXT_GAP),
    dimPt.clone().addScaledVector(dir, 2))
}

// One dimension: from a to b, with extension lines from edgeA/edgeB
function addDimension(group, edgeA, edgeB, a, b, labelOffset) {
  addExtensionLine(group, edgeA, a)
  addExtensionLine(group, edgeB, b)
  addLine(group, a, b)
  const dir = new THREE.Vector3().subVectors(b, a).normalize()
  addArrow(group, a, dir)
  addArrow(group, b, dir.clone().negate())
  const label = makeLabel(`${a.distanceTo(b).toFixed(1)} mm`, '#eeeeee', 0.75)
  label.position.copy(a).add(b).multiplyScalar(0.5).add(labelOffset)
  group.add(label)
}

export class DimensionsOverlay {
  constructor(parts) {
    this.parts = parts
    this.groups = new Map()
    this.visible = false
  }

  setVisible(v) {
    this.visible = v
    if (v) this.update()
    for (const g of this.groups.values()) g.visible = v
  }

  update() {
    for (const part of Object.values(this.parts)) {
      let group = this.groups.get(part.name)
      if (group) {
        group.parent?.remove(group)
        group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
      }
      if (!part.baseGeometry) continue
      group = new THREE.Group()
      group.userData.isGizmo = true
      group.visible = this.visible
      const { min, max } = part.bounds
      const z0 = min.z

      // width (X) along the front edge
      addDimension(group,
        new THREE.Vector3(min.x, min.y, z0),
        new THREE.Vector3(max.x, min.y, z0),
        new THREE.Vector3(min.x, min.y - OFFSET, z0),
        new THREE.Vector3(max.x, min.y - OFFSET, z0),
        new THREE.Vector3(0, -5, 0))

      // depth (Y) along the right edge
      addDimension(group,
        new THREE.Vector3(max.x, min.y, z0),
        new THREE.Vector3(max.x, max.y, z0),
        new THREE.Vector3(max.x + OFFSET, min.y, z0),
        new THREE.Vector3(max.x + OFFSET, max.y, z0),
        new THREE.Vector3(8, 0, 0))

      // thickness (Z) at the front-left corner
      addDimension(group,
        new THREE.Vector3(min.x, min.y, min.z),
        new THREE.Vector3(min.x, min.y, max.z),
        new THREE.Vector3(min.x - OFFSET, min.y - OFFSET, min.z),
        new THREE.Vector3(min.x - OFFSET, min.y - OFFSET, max.z),
        new THREE.Vector3(-6, -4, 0))

      part.mesh.add(group)
      this.groups.set(part.name, group)
    }
  }
}
