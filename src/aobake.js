import * as THREE from 'three'

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

  const data = new Uint8Array(resolution * resolution * 4)
  const filled = new Uint8Array(resolution * resolution)
  const t0 = performance.now()

  // Fan patches out across parallel workers, balanced by texel count
  const nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
  const buckets = Array.from({ length: nWorkers }, () => ({ patches: [], texels: 0 }))
  for (const p of [...patches].sort((x, y) =>
    (y.pw + 1) * (y.ph + 1) - (x.pw + 1) * (x.ph + 1))) {
    const bucket = buckets.reduce((m, b) => (b.texels < m.texels ? b : m))
    bucket.patches.push(p)
    bucket.texels += (p.pw + 1) * (p.ph + 1)
  }

  const progressPer = new Array(nWorkers).fill(0)
  await Promise.all(buckets.map((bucket, wi) => new Promise((resolve, reject) => {
    if (!bucket.patches.length) return resolve()
    const worker = new Worker(new URL('./aobake.worker.js', import.meta.url), { type: 'module' })
    worker.onerror = (err) => { worker.terminate(); reject(new Error(err.message || 'AO worker failed')) }
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        progressPer[wi] = e.data.done / e.data.total
        onProgress(progressPer.reduce((s, x) => s + x, 0) / nWorkers)
        return
      }
      const { indices, values } = e.data
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]
        const o = idx * 4
        data[o] = data[o + 1] = data[o + 2] = values[i]
        data[o + 3] = 255
        filled[idx] = 1
      }
      progressPer[wi] = 1
      onProgress(progressPer.reduce((s, x) => s + x, 0) / nWorkers)
      worker.terminate()
      resolve()
    }
    worker.postMessage({
      positions: geometries.map((g) => new Float32Array(g.attributes.position.array)),
      patches: bucket.patches.map(({ geo, tri, ax, ay, bx, by, cx, cy, pw, ph, px, py }) =>
        ({ geo, tri, ax, ay, bx, by, cx, cy, pw, ph, px, py })),
      scale, samples, maxDist, resolution,
    })
  })))

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
