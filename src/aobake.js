import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

// Ray-traced ambient-occlusion LIGHTMAP bake.
// Every triangle of every part is unwrapped into its own patch in a single
// shared texture atlas (per-triangle charting — robust for arbitrary CSG
// output, no UV seam ambiguity), then each texel is hemisphere-sampled
// against a BVH of its part. The result is applied as material.aoMap, so
// AO resolution is texel-based and independent of the triangulation.

const PAD = 2 // texels of padding around each patch

function faceNormal(pos, i, target) {
  const ax = pos[i], ay = pos[i + 1], az = pos[i + 2]
  const abx = pos[i + 3] - ax, aby = pos[i + 4] - ay, abz = pos[i + 5] - az
  const acx = pos[i + 6] - ax, acy = pos[i + 7] - ay, acz = pos[i + 8] - az
  target.set(
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx)
  return target
}

// Build per-triangle patches for all geometries and shelf-pack them.
// Writes atlas 'uv' attributes into each geometry. Returns patch list.
function packAtlas(geometries, texSize) {
  const patches = []
  let totalArea = 0
  const n = new THREE.Vector3()

  for (let g = 0; g < geometries.length; g++) {
    const pos = geometries[g].attributes.position.array
    for (let i = 0; i < pos.length; i += 9) {
      faceNormal(pos, i, n)
      const area = n.length() / 2
      totalArea += area
      // local 2D frame: p0 at origin, edge p0->p1 along +u
      const e1 = new THREE.Vector3(pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2])
      const len1 = e1.length()
      const u1 = e1.clone().normalize()
      const v1 = new THREE.Vector3().crossVectors(n, u1).normalize()
      const d = new THREE.Vector3(pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2])
      let cu = d.dot(u1), cv = d.dot(v1)
      if (cv < 0) cv = -cv // mirror is fine for AO
      const minU = Math.min(0, cu)
      patches.push({
        geo: g, tri: i,
        // triangle corners in local patch space (mm), origin at bbox min
        ax: -minU, ay: 0, bx: len1 - minU, by: 0, cx: cu - minU, cy: cv,
        w: Math.max(len1, cu) - minU, h: cv,
      })
    }
  }

  // choose a global mm->texel scale so patches fill ~55% of the atlas
  let scale = Math.sqrt((texSize * texSize * 0.55) / Math.max(totalArea, 1e-6))
  for (let attempt = 0; attempt < 12; attempt++) {
    const shelves = []
    let shelfY = PAD, shelfH = 0, x = PAD
    let ok = true
    const sorted = [...patches].sort((a, b) => b.h - a.h)
    for (const p of sorted) {
      p.pw = Math.max(1, Math.ceil(p.w * scale))
      p.ph = Math.max(1, Math.ceil(p.h * scale))
      if (p.pw + 2 * PAD > texSize) { ok = false; break }
      if (x + p.pw + PAD > texSize) { // new shelf
        shelfY += shelfH + PAD
        shelfH = 0
        x = PAD
      }
      if (shelfY + p.ph + PAD > texSize) { ok = false; break }
      p.px = x
      p.py = shelfY
      x += p.pw + PAD
      shelfH = Math.max(shelfH, p.ph)
    }
    if (ok) {
      // write atlas UVs
      for (const p of patches) {
        const geo = geometries[p.geo]
        if (!geo.userData._atlasUV) {
          geo.userData._atlasUV = new Float32Array((geo.attributes.position.count) * 2)
        }
        const uv = geo.userData._atlasUV
        const vi = (p.tri / 9) * 3
        const put = (slot, lx, ly) => {
          uv[(vi + slot) * 2] = (p.px + lx * scale) / texSize
          uv[(vi + slot) * 2 + 1] = (p.py + ly * scale) / texSize
        }
        put(0, p.ax, p.ay)
        put(1, p.bx, p.by)
        put(2, p.cx, p.cy)
      }
      for (const geo of geometries) {
        geo.setAttribute('uv', new THREE.BufferAttribute(geo.userData._atlasUV, 2))
        delete geo.userData._atlasUV
      }
      return { patches, scale }
    }
    scale *= 0.88
  }
  throw new Error('AO atlas packing failed — try a higher resolution')
}

export async function bakeAOLightmap(geometries, {
  resolution = 1024,
  samples = 16,
  maxDist = 15,
  onProgress = () => {},
} = {}) {
  const { patches, scale } = packAtlas(geometries, resolution)
  const bvhs = geometries.map((g) => new MeshBVH(g))

  const data = new Uint8Array(resolution * resolution * 4)
  const filled = new Uint8Array(resolution * resolution)

  const origin = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const bitangent = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const ray = new THREE.Ray()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()

  let texelBudget = 0
  const t0 = performance.now()
  for (let pi = 0; pi < patches.length; pi++) {
    const p = patches[pi]
    const pos = geometries[p.geo].attributes.position.array
    const i = p.tri
    a.set(pos[i], pos[i + 1], pos[i + 2])
    b.set(pos[i + 3], pos[i + 4], pos[i + 5])
    c.set(pos[i + 6], pos[i + 7], pos[i + 8])
    faceNormal(pos, i, normal).normalize()
    tangent.set(1, 0, 0)
    if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0)
    tangent.cross(normal).normalize()
    bitangent.crossVectors(normal, tangent)
    const bvh = bvhs[p.geo]

    // inverse barycentric setup in patch space
    const x0 = p.ax, y0 = p.ay, x1 = p.bx, y1 = p.by, x2 = p.cx, y2 = p.cy
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2) || 1e-9

    for (let ty = 0; ty <= p.ph; ty++) {
      for (let tx = 0; tx <= p.pw; tx++) {
        const lx = (tx + 0.5) / scale
        const ly = (ty + 0.5) / scale
        let w0 = ((y1 - y2) * (lx - x2) + (x2 - x1) * (ly - y2)) / det
        let w1 = ((y2 - y0) * (lx - x2) + (x0 - x2) * (ly - y2)) / det
        let w2 = 1 - w0 - w1
        // clamp slightly-outside texels to the triangle edge (gutter ring)
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
        const rot = ((tx * 7 + ty * 13) % 16) / 16 // decorrelate sample pattern
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
        const val = Math.round(255 * (0.25 + 0.75 * ao))
        const px = p.px + tx
        const py = p.py + ty
        if (px < 0 || py < 0 || px >= resolution || py >= resolution) continue
        const o = (py * resolution + px) * 4
        data[o] = data[o + 1] = data[o + 2] = val
        data[o + 3] = 255
        filled[py * resolution + px] = 1
      }
    }

    texelBudget += (p.pw + 1) * (p.ph + 1)
    if (texelBudget > 20000) {
      texelBudget = 0
      onProgress(pi / patches.length)
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // dilate: bleed patch borders into empty texels so bilinear taps stay clean
  for (let pass = 0; pass < 2; pass++) {
    const prev = filled.slice()
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const idx = y * resolution + x
        if (prev[idx]) continue
        let sum = 0, cnt = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= resolution || ny >= resolution) continue
          const ni = ny * resolution + nx
          if (prev[ni]) { sum += data[ni * 4]; cnt++ }
        }
        if (cnt) {
          const v = Math.round(sum / cnt)
          const o = idx * 4
          data[o] = data[o + 1] = data[o + 2] = v
          data[o + 3] = 255
          filled[idx] = 1
        }
      }
    }
  }
  // untouched texels -> white (no occlusion)
  for (let i = 0; i < resolution * resolution; i++) {
    if (!filled[i]) {
      const o = i * 4
      data[o] = data[o + 1] = data[o + 2] = 255
      data[o + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.channel = 0 // sample with the geometry's atlas 'uv' attribute
  tex.needsUpdate = true
  tex.userData.bakeMs = performance.now() - t0
  return tex
}

export function clearAtlasUV(geometry) {
  if (geometry.getAttribute('uv')) geometry.deleteAttribute('uv')
}
