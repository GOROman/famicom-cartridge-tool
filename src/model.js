import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { geometryToManifold, manifoldToGeometry } from './csg.js'
import { buildFeatureManifolds } from './features.js'

const stlLoader = new STLLoader()

// Normalise an arbitrary shell STL into the tool's canonical model space:
// thinnest bbox axis becomes Z, part centred on X/Y with zMin = 0, and the
// outer (large flat) face oriented towards −Z. Makes any template or
// imported shell behave like the bundled Dendy models.
export function normalizeGeometry(geo) {
  geo.computeBoundingBox()
  let size = new THREE.Vector3()
  geo.boundingBox.getSize(size)

  // thinnest axis -> Z
  if (size.x <= size.y && size.x <= size.z) geo.rotateY(Math.PI / 2)
  else if (size.y <= size.x && size.y <= size.z) geo.rotateX(-Math.PI / 2)

  // keep the long axis along X (cartridges are wider than tall)
  geo.computeBoundingBox()
  geo.boundingBox.getSize(size)
  if (size.y > size.x) geo.rotateZ(Math.PI / 2)

  // orient the outer face (the side with the larger flat area) towards −Z
  geo.computeBoundingBox()
  const { min, max } = geo.boundingBox
  const pos = geo.attributes.position
  const idx = geo.index
  const triCount = idx ? idx.count / 3 : pos.count / 3
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3()
  let areaLow = 0, areaHigh = 0
  const band = Math.max(0.5, (max.z - min.z) * 0.05)
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a))
    const area = n.length() / 2
    if (area < 1e-9) continue
    const nz = n.z / (2 * area)
    const zAvg = (a.z + b.z + c.z) / 3
    if (nz < -0.9 && zAvg < min.z + band) areaLow += area
    if (nz > 0.9 && zAvg > max.z - band) areaHigh += area
  }
  if (areaHigh > areaLow) geo.rotateX(Math.PI)

  // centre X/Y, rest bottom on z=0
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  geo.translate(
    -(bb.min.x + bb.max.x) / 2,
    -(bb.min.y + bb.max.y) / 2,
    -bb.min.z)
  return geo
}

// One cartridge half (top or bottom shell): a base STL geometry plus a
// non-destructive stack of parametric features, re-evaluated with Manifold
// CSG (watertight by construction — safe for slicers).
export class Part {
  constructor(name) {
    this.name = name
    this.baseGeometry = null
    this.baseManifold = null
    this.features = []
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry())
    this.mesh.visible = false
    this.bounds = new THREE.Box3()
    this.lastBuildMs = 0
  }

  async loadURL(url, onProgress) {
    this.setBaseGeometry(await stlLoader.loadAsync(url, onProgress))
  }

  loadArrayBuffer(buffer) {
    this.setBaseGeometry(stlLoader.parse(buffer))
  }

  setBaseGeometry(geo) {
    normalizeGeometry(geo)
    geo.computeVertexNormals()
    this.baseGeometry = geo
    this.baseGeometry.computeBoundingBox()
    this.bounds.copy(this.baseGeometry.boundingBox)
    this.baseManifold?.delete()
    this.baseManifold = geometryToManifold(geo)
    this.mesh.visible = true
  }

  rebuild(font) {
    if (!this.baseManifold) return
    const t0 = performance.now()
    let result = this.baseManifold

    for (const f of this.features) {
      if (!f.enabled) continue
      for (const { manifold: tool, subtract } of buildFeatureManifolds(f, this.bounds, font)) {
        const next = subtract ? result.subtract(tool) : result.add(tool)
        tool.delete()
        if (result !== this.baseManifold) result.delete()
        result = next
      }
    }

    this.mesh.geometry.dispose()
    this.exportGeometry?.dispose()
    this.exportGeometry = null // mesh.geometry IS the export geometry again
    this.mesh.geometry = manifoldToGeometry(result)
    if (result !== this.baseManifold) result.delete()
    this.lastBuildMs = performance.now() - t0
  }

  get triangleCount() {
    const g = this.mesh.geometry
    return g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3
  }
}
