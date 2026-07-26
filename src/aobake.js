import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

// Ray-traced ambient-occlusion bake: hemisphere-samples every vertex against
// a BVH of the part's own geometry and writes the result to vertex colors.
// Unlike screen-space GTAO this is view-independent — occlusion is "baked"
// into the mesh like a lightmap.

// Manifold's output uses large, optimally-merged triangles; per-vertex AO
// would interpolate corner darkness across whole faces. Subdivide long edges
// on a display-only copy first (the export geometry stays untouched).
export function subdivideForAO(geometry, maxEdge = 8, maxDepth = 6) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry
  const pos = src.attributes.position.array
  const out = []
  const emit = (ax, ay, az, bx, by, bz, cx, cy, cz, depth) => {
    const e2 = (x0, y0, z0, x1, y1, z1) => (x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2
    const m = Math.max(
      e2(ax, ay, az, bx, by, bz),
      e2(bx, by, bz, cx, cy, cz),
      e2(cx, cy, cz, ax, ay, az))
    if (depth >= maxDepth || m <= maxEdge * maxEdge) {
      out.push(ax, ay, az, bx, by, bz, cx, cy, cz)
      return
    }
    const ab = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2]
    const bc = [(bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2]
    const ca = [(cx + ax) / 2, (cy + ay) / 2, (cz + az) / 2]
    emit(ax, ay, az, ...ab, ...ca, depth + 1)
    emit(...ab, bx, by, bz, ...bc, depth + 1)
    emit(...ca, ...bc, cx, cy, cz, depth + 1)
    emit(...ab, ...bc, ...ca, depth + 1)
  }
  for (let i = 0; i < pos.length; i += 9) {
    emit(pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5],
      pos[i + 6], pos[i + 7], pos[i + 8], 0)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3))
  geo.computeVertexNormals()
  return geo
}

export async function bakeAO(geometry, {
  samples = 32,
  maxDist = 15,
  onProgress = () => {},
} = {}) {
  const bvh = new MeshBVH(geometry)
  const pos = geometry.attributes.position
  const nor = geometry.attributes.normal
  const count = pos.count
  const colors = new Float32Array(count * 3)

  const origin = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const ray = new THREE.Ray()

  const CHUNK = 25000
  for (let start = 0; start < count; start += CHUNK) {
    const end = Math.min(count, start + CHUNK)
    for (let i = start; i < end; i++) {
      origin.fromBufferAttribute(pos, i)
      normal.fromBufferAttribute(nor, i).normalize()
      // tangent frame around the vertex normal
      tangent.set(1, 0, 0)
      if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0)
      tangent.cross(normal).normalize()
      bitangent.crossVectors(normal, tangent)

      let occlusion = 0
      for (let s = 0; s < samples; s++) {
        // stratified cosine-weighted hemisphere sample
        const u = (s + 0.5) / samples
        const v = (s * 0.618033988749895) % 1
        const r = Math.sqrt(u)
        const phi = 2 * Math.PI * v
        dir.copy(tangent).multiplyScalar(r * Math.cos(phi))
          .addScaledVector(bitangent, r * Math.sin(phi))
          .addScaledVector(normal, Math.sqrt(Math.max(0, 1 - u)))
        ray.origin.copy(origin).addScaledVector(normal, 0.05)
        ray.direction.copy(dir)
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide)
        if (hit && hit.distance < maxDist) {
          occlusion += 1 - hit.distance / maxDist
        }
      }
      const ao = Math.max(0, 1 - occlusion / samples)
      const c = 0.25 + 0.75 * ao // keep crevices readable, not pitch black
      colors[i * 3] = c
      colors[i * 3 + 1] = c
      colors[i * 3 + 2] = c
    }
    onProgress(end / count)
    // yield to the event loop so the UI can update
    await new Promise((r) => setTimeout(r, 0))
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

export function clearBakedAO(geometry) {
  if (geometry.getAttribute('color')) geometry.deleteAttribute('color')
}
