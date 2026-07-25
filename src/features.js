import * as THREE from 'three'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'

// All features operate in model space: millimetres, Z-up,
// cartridge centred on X/Y with its bottom face at Z=0.

export const FEATURE_TYPES = ['Groove', 'Label Recess', 'Box', 'Cylinder', 'Text']

let featureId = 0

export function createFeature(type, partBounds) {
  const { max } = partBounds
  const base = { id: ++featureId, type, enabled: true, name: `${type} ${featureId}` }
  switch (type) {
    case 'Groove':
      return {
        ...base,
        axis: 'Y',        // groove runs along this axis
        position: 0,      // centre on the perpendicular axis
        count: 1,
        spacing: 6,
        width: 2,
        depth: 1,
        length: 0,        // 0 = full length
        face: 'Bottom',   // cut from Top (+Z) or Bottom (−Z); outer shell face is −Z
      }
    case 'Label Recess':
      return {
        ...base,
        width: 84, height: 53, cornerRadius: 3,
        x: 0, y: 0,
        depth: 0.6,
        face: 'Bottom',
      }
    case 'Box':
      return {
        ...base,
        op: 'Subtract',
        sizeX: 10, sizeY: 10, sizeZ: 5,
        x: 0, y: 0, z: max.z,
        rotZ: 0,
      }
    case 'Cylinder':
      return {
        ...base,
        op: 'Subtract',
        radius: 3, height: 10,
        x: 0, y: 0, z: max.z,
        axis: 'Z',
      }
    case 'Text':
      return {
        ...base,
        op: 'Engrave',
        text: 'FAMICOM',
        size: 8,
        depth: 0.8,
        x: 0, y: 0,
        rotZ: 0,
        face: 'Bottom',
      }
  }
}

// Returns { geometry, subtract } or an array of them; null when nothing to build.
export function buildFeatureGeometry(f, partBounds, font) {
  switch (f.type) {
    case 'Groove': return buildGroove(f, partBounds)
    case 'Label Recess': return buildLabelRecess(f, partBounds)
    case 'Box': return buildBox(f)
    case 'Cylinder': return buildCylinder(f)
    case 'Text': return buildText(f, partBounds, font)
  }
  return null
}

const EPS = 0.05 // overshoot so cuts fully pierce surfaces

function faceZ(face, f, bounds) {
  // Returns [zMin, zMax] of a cut of depth f.depth entering from the given face.
  if (face === 'Top') return [bounds.max.z - f.depth, bounds.max.z + EPS]
  return [bounds.min.z - EPS, bounds.min.z + f.depth]
}

function buildGroove(f, bounds) {
  const along = f.axis === 'Y' ? 'y' : 'x'
  const across = f.axis === 'Y' ? 'x' : 'y'
  const fullLen = bounds.max[along] - bounds.min[along] + 2 * EPS
  const len = f.length > 0 ? f.length : fullLen
  const [z0, z1] = faceZ(f.face, f, bounds)

  const out = []
  const start = f.position - ((f.count - 1) * f.spacing) / 2
  for (let i = 0; i < f.count; i++) {
    const sizes = { z: z1 - z0 }
    sizes[along] = len
    sizes[across] = f.width
    const geo = new THREE.BoxGeometry(sizes.x, sizes.y, sizes.z)
    const pos = { z: (z0 + z1) / 2 }
    pos[along] = f.length > 0 ? (bounds.min[along] + bounds.max[along]) / 2 : 0
    pos[across] = start + i * f.spacing
    geo.translate(pos.x, pos.y, pos.z)
    out.push({ geometry: geo, subtract: true })
  }
  return out
}

function roundedRectShape(w, h, r) {
  const shape = new THREE.Shape()
  const x = -w / 2, y = -h / 2
  r = Math.min(r, w / 2, h / 2)
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y)
  shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0)
  shape.lineTo(x + w, y + h - r)
  shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  shape.lineTo(x + r, y + h)
  shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  shape.lineTo(x, y + r)
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
  return shape
}

function buildLabelRecess(f, bounds) {
  const shape = roundedRectShape(f.width, f.height, f.cornerRadius)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: f.depth + EPS, bevelEnabled: false, curveSegments: 16,
  })
  const [z0] = faceZ(f.face, f, bounds)
  geo.translate(f.x, f.y, f.face === 'Top' ? z0 : bounds.min.z - EPS)
  return { geometry: geo, subtract: true }
}

function buildBox(f) {
  const geo = new THREE.BoxGeometry(f.sizeX, f.sizeY, f.sizeZ)
  geo.rotateZ(THREE.MathUtils.degToRad(f.rotZ))
  geo.translate(f.x, f.y, f.z)
  return { geometry: geo, subtract: f.op === 'Subtract' }
}

function buildCylinder(f) {
  const geo = new THREE.CylinderGeometry(f.radius, f.radius, f.height, 48)
  if (f.axis === 'Z') geo.rotateX(Math.PI / 2)
  else if (f.axis === 'X') geo.rotateZ(Math.PI / 2)
  geo.translate(f.x, f.y, f.z)
  return { geometry: geo, subtract: f.op === 'Subtract' }
}

function buildText(f, bounds, font) {
  if (!font || !f.text) return null
  const engrave = f.op === 'Engrave'
  const depth = f.depth + (engrave ? EPS : 0)
  const geo = new TextGeometry(f.text, {
    font, size: f.size, depth, curveSegments: 6, bevelEnabled: false,
  })
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  // centre text on its own origin
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0)
  geo.rotateZ(THREE.MathUtils.degToRad(f.rotZ))

  let z
  if (f.face === 'Top') {
    z = engrave ? bounds.max.z - f.depth : bounds.max.z - EPS
  } else {
    // Mirror so the text reads correctly when viewed from below
    geo.scale(-1, 1, 1)
    z = engrave ? bounds.min.z - EPS : bounds.min.z - f.depth + EPS
  }
  geo.translate(f.x, f.y, z)
  return { geometry: geo, subtract: engrave }
}
