import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import Module from 'manifold-3d'

// Manifold (WASM) CSG backend. Unlike BVH-based CSG it guarantees watertight,
// manifold output, so exported STLs survive slicer import untouched.

let wasm = null

export async function initManifold() {
  if (wasm) return wasm
  wasm = await Module()
  wasm.setup()
  return wasm
}

export function manifoldAPI() {
  if (!wasm) throw new Error('Manifold WASM not initialised')
  return wasm
}

// BufferGeometry (possibly unindexed STL soup) -> Manifold
export function geometryToManifold(geo) {
  const { Manifold, Mesh } = manifoldAPI()
  let g = geo.clone()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name)
  }
  g = mergeVertices(g, 1e-4)
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(g.attributes.position.array),
    triVerts: new Uint32Array(g.index.array),
  })
  mesh.merge() // heal remaining near-duplicate vertices
  return new Manifold(mesh)
}

// Manifold -> BufferGeometry (non-indexed, flat shaded for crisp CAD edges)
export function manifoldToGeometry(manifold) {
  const mesh = manifold.getMesh()
  let geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3))
  geo.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1))
  geo = geo.toNonIndexed()
  geo.computeVertexNormals()
  return geo
}

// THREE.Shape[] (text glyphs, rounded rects...) -> CrossSection.
// Fill-rule based construction tolerates self-intersecting font outlines.
export function shapesToCrossSection(shapes, curveSegments = 8) {
  const { CrossSection } = manifoldAPI()
  const polys = []
  for (const shape of shapes) {
    const { shape: outer, holes } = shape.extractPoints(curveSegments)
    for (const contour of [outer, ...holes]) {
      polys.push(contour.map((p) => [p.x, p.y]))
    }
  }
  return new CrossSection(polys, 'NonZero')
}
