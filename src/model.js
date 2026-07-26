import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { geometryToManifold, manifoldToGeometry } from './csg.js'
import { buildFeatureManifolds } from './features.js'

const stlLoader = new STLLoader()

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
