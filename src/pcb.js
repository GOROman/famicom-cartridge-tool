import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { geometryToManifold, manifoldToGeometry, manifoldAPI } from './csg.js'

// PCB fit-testing: import a .STEP board (OpenCASCADE WASM, lazy-loaded),
// place it inside the bottom shell, and run a DRC that reports actual
// CSG intersection volumes between the board and both shells.

let occtPromise = null
async function getOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
        import('occt-import-js'),
        import('occt-import-js/dist/occt-import-js.wasm?url'),
      ])
      return factory({ locateFile: () => wasmUrl })
    })()
  }
  return occtPromise
}

export class PCBManager {
  constructor(bottomPart) {
    this.bottomPart = bottomPart
    this.group = new THREE.Group() // child of bottom mesh -> model space
    this.group.userData.isGizmo = true // keep render-mode material swaps away
    bottomPart.mesh.add(this.group)
    this.geometry = null // merged, in PCB-local space
    this.name = ''
    this.params = { x: 0, y: 0, z: 6.7, rotZ: 0, flip: false, opacity: 1 }
    this.highlights = []
  }

  get loaded() {
    return !!this.geometry
  }

  async loadStep(buffer, name, onStatus = () => {}) {
    onStatus('Loading STEP engine (OpenCASCADE)…')
    const occt = await getOcct()
    onStatus('Parsing STEP…')
    const result = occt.ReadStepFile(new Uint8Array(buffer), null)
    if (!result.success || !result.meshes.length) {
      throw new Error('STEP parse failed')
    }
    const geos = result.meshes.map((m) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.attributes.position.array), 3))
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.index.array), 1))
      return g.toNonIndexed()
    })
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    merged.computeVertexNormals()

    // centre on X/Y, rest the board's underside on local z=0
    merged.computeBoundingBox()
    const bb = merged.boundingBox
    merged.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z)
    merged.computeBoundingBox()

    this.clear()
    this.geometry = merged
    this.name = name
    const size = new THREE.Vector3()
    merged.boundingBox.getSize(size)
    this.mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      color: 0x1f8a3d, roughness: 0.6, metalness: 0.1,
      transparent: true, opacity: this.params.opacity,
    }))
    this.mesh.userData.isGizmo = true
    this.group.add(this.mesh)
    this.applyParams()
    return size
  }

  applyParams() {
    const p = this.params
    this.group.position.set(p.x, p.y, p.z)
    this.group.rotation.set(p.flip ? Math.PI : 0, 0, THREE.MathUtils.degToRad(p.rotZ))
    if (this.mesh) this.mesh.material.opacity = p.opacity
  }

  // PCB solid transformed into the bottom shell's model space
  pcbMatrixInBottomSpace() {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(this.params.x, this.params.y, this.params.z),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(this.params.flip ? Math.PI : 0, 0, THREE.MathUtils.degToRad(this.params.rotZ))),
      new THREE.Vector3(1, 1, 1))
    return m
  }

  // Run design-rule checks. seatZ = assembled cartridge height (mm).
  runDRC(topPart, seatZ) {
    if (!this.geometry) throw new Error('No PCB loaded')
    this.clearHighlights()
    const issues = []

    let pcbBase
    try {
      pcbBase = geometryToManifold(this.geometry)
    } catch {
      throw new Error('PCB mesh is not watertight — DRC unavailable for this STEP')
    }
    const pcbBottomSpace = pcbBase.transform(this.pcbMatrixInBottomSpace().elements)
    pcbBase.delete()

    // 1) collision with the bottom shell (same space)
    this.checkAgainst(pcbBottomSpace, this.bottomPart, new THREE.Matrix4(), 'Bottom shell', issues)

    // 2) collision with the top shell in the CLOSED (assembled) position.
    // assembled: bottom = Rz(pi) p ; top = Rx(pi) p + (0,0,seatZ)
    // => p_top = Rx(pi) * (Rz(pi) p_bottom - (0,0,seatZ))
    const rz = new THREE.Matrix4().makeRotationZ(Math.PI)
    const rx = new THREE.Matrix4().makeRotationX(Math.PI)
    const toTop = new THREE.Matrix4()
      .multiply(rx)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -seatZ))
      .multiply(rz)
    this.checkAgainst(pcbBottomSpace, topPart, toTop, 'Top shell (closed)', issues)

    // 3) board outside the closed case volume?
    const bb = new THREE.Box3().setFromBufferAttribute(this.geometry.attributes.position)
    const size = new THREE.Vector3()
    bb.getSize(size)
    const zTop = this.params.z + (this.params.flip ? 0 : size.z)
    const innerTop = seatZ - 2 // top shell floor in bottom space
    if (zTop > innerTop + 1e-3) {
      issues.push(`Board top (${zTop.toFixed(1)} mm) exceeds the closed-case interior (${innerTop.toFixed(1)} mm)`)
    }
    pcbBottomSpace.delete()
    return issues
  }

  // intersect PCB (bottom space) with a shell; toShell maps bottom->shell space
  checkAgainst(pcbBottomSpace, part, toShell, label, issues) {
    const shell = part.baseManifold ? geometryToManifold(part.mesh.geometry) : null
    if (!shell) return
    const pcbShellSpace = pcbBottomSpace.transform(toShell.elements)
    const inter = pcbShellSpace.intersect(shell)
    const vol = inter.volume()
    if (vol > 0.05) {
      issues.push(`${label}: ${vol.toFixed(1)} mm³ overlap`)
      // highlight the overlap, mapped back into bottom space for display
      const backM = toShell.clone().invert()
      const interBottom = inter.transform(backM.elements)
      const geo = manifoldToGeometry(interBottom)
      const hl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xff2222, depthTest: false, transparent: true, opacity: 0.85,
      }))
      hl.renderOrder = 995
      hl.userData.isGizmo = true
      this.bottomPart.mesh.add(hl)
      this.highlights.push(hl)
      interBottom.delete()
    }
    inter.delete()
    pcbShellSpace.delete()
    shell.delete()
  }

  clearHighlights() {
    for (const h of this.highlights) {
      h.parent?.remove(h)
      h.geometry.dispose()
      h.material.dispose()
    }
    this.highlights = []
  }

  clear() {
    this.clearHighlights()
    if (this.mesh) {
      this.group.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
      this.mesh = null
    }
    this.geometry = null
    this.name = ''
  }
}
