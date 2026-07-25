import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const exporter = new STLExporter()

// Exports geometries in model space (mm, Z-up) as binary STL, ignoring any
// display transforms on the scene meshes.
export function exportSTL(geometries, filename) {
  const clones = geometries.map((g) => {
    const c = g.clone()
    if (c.index) return c.toNonIndexed()
    return c
  })
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
