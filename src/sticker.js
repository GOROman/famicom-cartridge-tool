import * as THREE from 'three'

// Display-only textured sticker planes, parented to a part mesh so they
// follow all display transforms. Not part of the CSG solid or STL export.

const texLoader = new THREE.TextureLoader()

// Rounded-rectangle sticker outline with normalised UVs
function roundedRectGeometry(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2 - 0.01, h / 2 - 0.01))
  const x = -w / 2, y = -h / 2
  const shape = new THREE.Shape()
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y)
  shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0)
  shape.lineTo(x + w, y + h - r)
  shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  shape.lineTo(x + r, y + h)
  shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  shape.lineTo(x, y + r)
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
  const geo = new THREE.ShapeGeometry(shape, 12)
  const pos = geo.attributes.position
  const uv = geo.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5)
  }
  return geo
}

export class StickerManager {
  constructor() {
    this.meshes = new Map() // feature id -> mesh
  }

  async setImage(part, f, url, name) {
    f.imageURL = url
    f.imageName = name
    const tex = await texLoader.loadAsync(url)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    const mesh = this.ensureMesh(part, f)
    mesh.material.map?.dispose()
    mesh.material.map = tex
    mesh.material.needsUpdate = true
    if (tex.image?.width) {
      f._aspect = tex.image.width / tex.image.height
      if (f.lockAspect) f.height = f.width / f._aspect
    }
    this.update(part, f)
    return tex
  }

  ensureMesh(part, f) {
    let mesh = this.meshes.get(f.id)
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({
          roughness: 0.55, metalness: 0,
          transparent: true, opacity: f.opacity,
          polygonOffset: true, polygonOffsetFactor: -1,
        }))
      mesh.userData.isSticker = true
      mesh.renderOrder = 10
      part.mesh.add(mesh)
      this.meshes.set(f.id, mesh)
    }
    return mesh
  }

  update(part, f) {
    const mesh = this.meshes.get(f.id)
    if (!mesh) return
    mesh.visible = f.enabled && !!f.imageURL
    const shapeKey = `${f.width}|${f.height}|${f.cornerRadius}`
    if (mesh.userData.shapeKey !== shapeKey) {
      mesh.geometry.dispose()
      mesh.geometry = roundedRectGeometry(f.width, f.height, f.cornerRadius ?? 0)
      mesh.userData.shapeKey = shapeKey
    }
    mesh.material.opacity = f.opacity

    const rotZ = THREE.MathUtils.degToRad(f.rotZ)
    if (f.face === 'Top') {
      mesh.position.set(f.x, f.y, part.bounds.max.z + 0.05)
      mesh.rotation.set(0, 0, rotZ)
    } else {
      // face the outer (−Z) side; rotateX(π) keeps the image upright when
      // the shell is shown flipped outer-face-up
      mesh.position.set(f.x, f.y, part.bounds.min.z - 0.05)
      mesh.rotation.set(Math.PI, 0, rotZ)
    }
  }

  remove(f) {
    const mesh = this.meshes.get(f.id)
    if (!mesh) return
    mesh.parent?.remove(mesh)
    mesh.geometry.dispose()
    mesh.material.map?.dispose()
    mesh.material.dispose()
    this.meshes.delete(f.id)
  }
}
