import * as THREE from 'three'
import { manifoldAPI, shapesToCrossSection } from './csg.js'

// All features operate in model space: millimetres, Z-up,
// cartridge centred on X/Y with its bottom face at Z=0.
// Builders return Manifold solids (see csg.js) as {manifold, subtract} lists.

export const FEATURE_TYPES = ['Groove', 'Label Recess', 'Box', 'Cylinder', 'Text', 'Sticker']

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
    case 'Sticker':
      // Display-only textured label (PNG/JPG); not part of the CSG solid
      return {
        ...base,
        width: 84, height: 53,
        x: 0, y: 0,
        rotZ: 0,
        opacity: 1,
        lockAspect: true,
        face: 'Bottom',
        imageURL: null,
        imageName: '',
      }
  }
}

// Returns an array of {manifold, subtract}; empty when nothing to build.
export function buildFeatureManifolds(f, partBounds, font) {
  switch (f.type) {
    case 'Groove': return buildGroove(f, partBounds)
    case 'Label Recess': return [buildLabelRecess(f, partBounds)]
    case 'Box': return [buildBox(f)]
    case 'Cylinder': return [buildCylinder(f)]
    case 'Text': return buildText(f, partBounds, font)
    case 'Sticker': return [] // rendered as a textured overlay, not CSG
  }
  return []
}

const EPS = 0.05 // overshoot so cuts fully pierce surfaces

function faceZ(face, f, bounds) {
  // [zMin, zMax] of a cut of depth f.depth entering from the given face.
  if (face === 'Top') return [bounds.max.z - f.depth, bounds.max.z + EPS]
  return [bounds.min.z - EPS, bounds.min.z + f.depth]
}

function buildGroove(f, bounds) {
  const { Manifold } = manifoldAPI()
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
    const pos = { z: (z0 + z1) / 2 }
    pos[along] = f.length > 0 ? (bounds.min[along] + bounds.max[along]) / 2 : 0
    pos[across] = start + i * f.spacing
    out.push({
      manifold: Manifold.cube([sizes.x, sizes.y, sizes.z], true)
        .translate([pos.x, pos.y, pos.z]),
      subtract: true,
    })
  }
  return out
}

function buildLabelRecess(f, bounds) {
  const { CrossSection } = manifoldAPI()
  const r = Math.min(f.cornerRadius, f.width / 2 - 0.01, f.height / 2 - 0.01)
  let cs = CrossSection.square([f.width - 2 * r, f.height - 2 * r], true)
  if (r > 0) cs = cs.offset(r, 'Round', undefined, 32)
  const [z0] = faceZ(f.face, f, bounds)
  const solid = cs.extrude(f.depth + EPS)
    .translate([f.x, f.y, f.face === 'Top' ? z0 : bounds.min.z - EPS])
  return { manifold: solid, subtract: true }
}

function buildBox(f) {
  const { Manifold } = manifoldAPI()
  const m = Manifold.cube([f.sizeX, f.sizeY, f.sizeZ], true)
    .rotate([0, 0, f.rotZ])
    .translate([f.x, f.y, f.z])
  return { manifold: m, subtract: f.op === 'Subtract' }
}

function buildCylinder(f) {
  const { Manifold } = manifoldAPI()
  let m = Manifold.cylinder(f.height, f.radius, f.radius, 48, true)
  if (f.axis === 'X') m = m.rotate([0, 90, 0])
  else if (f.axis === 'Y') m = m.rotate([90, 0, 0])
  m = m.translate([f.x, f.y, f.z])
  return { manifold: m, subtract: f.op === 'Subtract' }
}

function buildText(f, bounds, font) {
  if (!font || !f.text) return []
  const engrave = f.op === 'Engrave'
  const depth = f.depth + (engrave ? EPS : 0)

  const shapes = font.generateShapes(f.text, f.size)
  const geoForBounds = new THREE.ShapeGeometry(shapes, 4)
  geoForBounds.computeBoundingBox()
  const bb = geoForBounds.boundingBox
  const cx = (bb.min.x + bb.max.x) / 2
  const cy = (bb.min.y + bb.max.y) / 2

  let m = shapesToCrossSection(shapes, 6).extrude(depth)
    .translate([-cx, -cy, 0])
    .rotate([0, 0, f.rotZ])

  let z
  if (f.face === 'Top') {
    z = engrave ? bounds.max.z - f.depth : bounds.max.z - EPS
  } else {
    // Mirror so the text reads correctly when viewed from below
    m = m.mirror([1, 0, 0])
    z = engrave ? bounds.min.z - EPS : bounds.min.z - f.depth + EPS
  }
  m = m.translate([f.x, f.y, z])
  return [{ manifold: m, subtract: engrave }]
}
