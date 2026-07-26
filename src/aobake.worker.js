import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

// AO lightmap bake worker: hemisphere-raycasts a subset of atlas patches
// against BVHs of the part geometries. Several workers run in parallel.

onmessage = (e) => {
  const { positions, patches, scale, samples, maxDist, resolution } = e.data

  const bvhs = positions.map((arr) => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return { bvh: new MeshBVH(geo), pos: arr }
  })

  const origin = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const ray = new THREE.Ray()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3()

  const idxOut = []
  const valOut = []
  let sinceReport = 0

  for (let pi = 0; pi < patches.length; pi++) {
    const p = patches[pi]
    const pos = bvhs[p.geo].pos
    const i = p.tri
    a.set(pos[i], pos[i + 1], pos[i + 2])
    b.set(pos[i + 3], pos[i + 4], pos[i + 5])
    c.set(pos[i + 6], pos[i + 7], pos[i + 8])
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    normal.crossVectors(ab, ac).normalize()
    tangent.set(1, 0, 0)
    if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0)
    tangent.cross(normal).normalize()
    bitangent.crossVectors(normal, tangent)
    const bvh = bvhs[p.geo].bvh

    const x0 = p.ax, y0 = p.ay, x1 = p.bx, y1 = p.by, x2 = p.cx, y2 = p.cy
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2) || 1e-9

    for (let ty = 0; ty <= p.ph; ty++) {
      for (let tx = 0; tx <= p.pw; tx++) {
        const lx = (tx + 0.5) / scale
        const ly = (ty + 0.5) / scale
        let w0 = ((y1 - y2) * (lx - x2) + (x2 - x1) * (ly - y2)) / det
        let w1 = ((y2 - y0) * (lx - x2) + (x0 - x2) * (ly - y2)) / det
        let w2 = 1 - w0 - w1
        if (w0 < -0.25 || w1 < -0.25 || w2 < -0.25) continue
        w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2)
        const s = w0 + w1 + w2
        w0 /= s; w1 /= s; w2 /= s

        origin.set(
          a.x * w0 + b.x * w1 + c.x * w2,
          a.y * w0 + b.y * w1 + c.y * w2,
          a.z * w0 + b.z * w1 + c.z * w2)
        origin.addScaledVector(normal, 0.05)

        let occlusion = 0
        const rot = ((tx * 7 + ty * 13) % 16) / 16
        for (let sIdx = 0; sIdx < samples; sIdx++) {
          const u = (sIdx + 0.5) / samples
          const v = (sIdx * 0.618033988749895 + rot) % 1
          const r = Math.sqrt(u)
          const phi = 2 * Math.PI * v
          dir.copy(tangent).multiplyScalar(r * Math.cos(phi))
            .addScaledVector(bitangent, r * Math.sin(phi))
            .addScaledVector(normal, Math.sqrt(Math.max(0, 1 - u)))
          ray.origin.copy(origin)
          ray.direction.copy(dir)
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide)
          if (hit && hit.distance < maxDist) occlusion += 1 - hit.distance / maxDist
        }
        const ao = Math.max(0, 1 - occlusion / samples)
        const px = p.px + tx
        const py = p.py + ty
        if (px < 0 || py < 0 || px >= resolution || py >= resolution) continue
        idxOut.push(py * resolution + px)
        valOut.push(Math.round(255 * (0.25 + 0.75 * ao)))
      }
    }
    sinceReport += (p.pw + 1) * (p.ph + 1)
    if (sinceReport > 30000) {
      sinceReport = 0
      postMessage({ type: 'progress', done: pi + 1, total: patches.length })
    }
  }

  const indices = new Uint32Array(idxOut)
  const values = new Uint8Array(valOut)
  postMessage({ type: 'result', indices, values }, [indices.buffer, values.buffer])
}
