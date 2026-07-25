import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

export const RENDER_MODES = ['Wireframe', 'Simple', 'PBR (HDR)']

export class Viewer {
  constructor(container) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a1e)

    this.camera = new THREE.PerspectiveCamera(
      45, container.clientWidth / container.clientHeight, 1, 2000)
    this.camera.position.set(90, 110, 160)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 5, 0)
    this.controls.enableDamping = true

    // Model group: model space is Z-up (STL), scene is Y-up
    this.modelGroup = new THREE.Group()
    this.modelGroup.rotation.x = -Math.PI / 2
    this.scene.add(this.modelGroup)

    // Lights (used by Simple and PBR modes; PBR also uses environment)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.35)
    this.scene.add(this.ambient)

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2)
    this.sun.position.set(80, 140, 60)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const s = 140
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: 500 })
    this.sun.shadow.bias = -0.0005
    this.scene.add(this.sun)

    this.fill = new THREE.DirectionalLight(0xaaccff, 0.5)
    this.fill.position.set(-90, 60, -80)
    this.scene.add(this.fill)

    // Ground plane that only receives shadows
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.ShadowMaterial({ opacity: 0.35 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.02
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.grid = new THREE.GridHelper(400, 40, 0x444455, 0x2a2a33)
    this.grid.position.y = -0.01
    this.scene.add(this.grid)

    // Environment map (procedural room by default, replaceable with a .hdr file)
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.roomEnv = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.hdrEnv = null
    this.showEnvBackground = false

    // Materials shared by all part meshes
    this.materials = {
      'Wireframe': new THREE.MeshBasicMaterial({ color: 0x44ddff, wireframe: true }),
      'Simple': new THREE.MeshPhongMaterial({ color: 0xd8b25a, shininess: 30 }),
      'PBR (HDR)': new THREE.MeshPhysicalMaterial({
        color: 0xd8b25a, roughness: 0.45, metalness: 0.0,
        clearcoat: 0.15, clearcoatRoughness: 0.5,
      }),
    }
    this.renderMode = 'PBR (HDR)'
    this.shadowsEnabled = true

    // Screen-space ambient occlusion (GTAO) post-processing chain
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.aoPass = new GTAOPass(this.scene, this.camera,
      container.clientWidth, container.clientHeight)
    this.setAOParams({ radius: 4, intensity: 1 })
    this.composer.addPass(this.aoPass)
    this.composer.addPass(new OutputPass())
    this.aoEnabled = true

    window.addEventListener('resize', () => this.onResize())
    this.renderer.setAnimationLoop(() => {
      this.controls.update()
      if (this.aoEnabled && this.renderMode !== 'Wireframe') {
        this.composer.render()
      } else {
        this.renderer.render(this.scene, this.camera)
      }
    })
    this.applyRenderMode()
  }

  setAO(enabled) {
    this.aoEnabled = enabled
  }

  setAOParams({ radius, intensity }) {
    if (intensity !== undefined) this.aoPass.blendIntensity = intensity
    if (radius !== undefined) {
      // radius is in world units (mm here)
      this.aoPass.updateGtaoMaterial({
        radius,
        distanceExponent: 1,
        thickness: 1,
        scale: 1,
        samples: 16,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      })
    }
  }

  onResize() {
    const { clientWidth: w, clientHeight: h } = this.container
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }

  get activeEnv() {
    return this.hdrEnv ?? this.roomEnv
  }

  setRenderMode(mode) {
    this.renderMode = mode
    this.applyRenderMode()
  }

  setShadows(enabled) {
    this.shadowsEnabled = enabled
    this.applyRenderMode()
  }

  setBodyColor(hex) {
    this.materials['Simple'].color.set(hex)
    this.materials['PBR (HDR)'].color.set(hex)
  }

  setEnvBackground(show) {
    this.showEnvBackground = show
    this.applyRenderMode()
  }

  async loadHDR(url) {
    const tex = await new RGBELoader().loadAsync(url)
    tex.mapping = THREE.EquirectangularReflectionMapping
    this.hdrEnvRaw?.dispose()
    this.hdrEnvRaw = tex
    this.hdrEnv = this.pmrem.fromEquirectangular(tex).texture
    this.applyRenderMode()
  }

  // Back to the procedural room environment
  clearHDR() {
    this.hdrEnvRaw?.dispose()
    this.hdrEnvRaw = null
    this.hdrEnv = null
    this.applyRenderMode()
  }

  applyRenderMode() {
    const mode = this.renderMode
    const pbr = mode === 'PBR (HDR)'
    const wire = mode === 'Wireframe'

    this.scene.environment = pbr ? this.activeEnv : null
    this.scene.background = pbr && this.showEnvBackground && this.hdrEnvRaw
      ? this.hdrEnvRaw
      : new THREE.Color(0x1a1a1e)

    const shadows = this.shadowsEnabled && !wire
    this.renderer.shadowMap.enabled = shadows
    this.sun.castShadow = shadows
    this.ground.visible = shadows
    this.sun.visible = !wire
    this.fill.visible = !wire
    this.ambient.visible = !wire
    // Lower direct light in PBR mode since the environment contributes light
    this.sun.intensity = pbr ? 1.4 : 2.2
    this.ambient.intensity = pbr ? 0.1 : 0.35

    const mat = this.materials[mode]
    this.modelGroup.traverse((obj) => {
      if (obj.isMesh && !obj.userData.isGizmo) {
        obj.material = mat
        obj.castShadow = shadows
        obj.receiveShadow = shadows
        // force re-upload in case shadow flags changed
        obj.material.needsUpdate = true
      }
    })
  }
}
