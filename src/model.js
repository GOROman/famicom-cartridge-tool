import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { Brush, Evaluator, ADDITION, SUBTRACTION } from 'three-bvh-csg'
import { buildFeatureGeometry } from './features.js'

const evaluator = new Evaluator()
evaluator.attributes = ['position', 'normal']
evaluator.useGroups = false

const stlLoader = new STLLoader()

// One cartridge half (top or bottom shell): a base STL geometry plus a
// non-destructive stack of parametric features, re-evaluated with CSG.
export class Part {
  constructor(name) {
    this.name = name
    this.baseGeometry = null
    this.features = []
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry())
    this.mesh.visible = false
    this.bounds = new THREE.Box3()
    this.lastBuildMs = 0
  }

  async loadURL(url) {
    this.setBaseGeometry(await stlLoader.loadAsync(url))
  }

  loadArrayBuffer(buffer) {
    this.setBaseGeometry(stlLoader.parse(buffer))
  }

  setBaseGeometry(geo) {
    geo.computeVertexNormals()
    this.baseGeometry = geo
    this.baseGeometry.computeBoundingBox()
    this.bounds.copy(this.baseGeometry.boundingBox)
    this.mesh.visible = true
  }

  rebuild(font) {
    if (!this.baseGeometry) return
    const t0 = performance.now()
    let result = new Brush(this.baseGeometry)
    result.updateMatrixWorld()

    for (const f of this.features) {
      if (!f.enabled) continue
      const built = buildFeatureGeometry(f, this.bounds, font)
      if (!built) continue
      for (const { geometry, subtract } of [].concat(built)) {
        const tool = new Brush(geometry)
        tool.updateMatrixWorld()
        result = evaluator.evaluate(result, tool, subtract ? SUBTRACTION : ADDITION)
      }
    }

    this.mesh.geometry.dispose()
    this.mesh.geometry = result.geometry
    this.lastBuildMs = performance.now() - t0
  }

  get triangleCount() {
    const g = this.mesh.geometry
    return g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3
  }
}
