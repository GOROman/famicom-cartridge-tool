import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const exporter = new STLExporter()

// CSG output is an unwelded triangle soup with tiny numeric differences
// between coincident vertices; slicers' mesh repair can mangle thin features
// (e.g. engraved text). Weld vertices so shared corners become bitwise
// identical and drop degenerate triangles, giving slicers a clean manifold.
export function cleanGeometry(geo, tolerance = 1e-3) {
  let g = geo.clone()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name)
  }
  g = mergeVertices(g, tolerance)

  const pos = g.attributes.position
  const idx = g.index.array
  const kept = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3()
  for (let i = 0; i < idx.length; i += 3) {
    const [i0, i1, i2] = [idx[i], idx[i + 1], idx[i + 2]]
    if (i0 === i1 || i1 === i2 || i2 === i0) continue
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    if (ab.cross(ac).lengthSq() < 1e-12) continue // zero-area sliver
    kept.push(i0, i1, i2)
  }
  g.setIndex(kept)
  return g
}

// Exports geometries in model space (mm, Z-up) as binary STL, ignoring any
// display transforms on the scene meshes.
export function exportSTL(geometries, filename) {
  const clones = geometries.map((g) => cleanGeometry(g).toNonIndexed())
  const merged = clones.length === 1 ? clones[0] : mergeGeometries(clones, false)
  const mesh = new THREE.Mesh(merged)
  const data = exporter.parse(mesh, { binary: true })
  const blob = new Blob([data], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
