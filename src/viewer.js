import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'

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

    this.grid = new THREE.GridHelper(400, 40, 0xccccdd, 0x888899)
    this.grid.position.y = -0.01
    this.scene.add(this.grid)

    // Model-space axes: X red, Y green, Z blue (Z-up, matches STL space)
    this.axes = new THREE.AxesHelper(70)
    this.axes.material.depthTest = false
    this.axes.renderOrder = 900
    this.modelGroup.add(this.axes)

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
    this.renderMode = 'Simple'
    this.shadowsEnabled = true

    // Post-processing chain: GTAO -> bloom -> tone-mapped output
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.aoPass = new GTAOPass(this.scene, this.camera,
      container.clientWidth, container.clientHeight)
    this.setAOParams({ radius: 6, intensity: 1.5 })
    this.composer.addPass(this.aoPass)
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.25, 0.3, 1.0)
    this.bloomPass.enabled = false
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())
    // SMAA after tone mapping — the composer path bypasses MSAA, so this
    // restores anti-aliasing when AO/bloom post-processing is active
    this.smaaPass = new SMAAPass(container.clientWidth, container.clientHeight)
    this.composer.addPass(this.smaaPass)
    this.aoEnabled = false

    // FPS counter
    this.fpsElement = null
    let frames = 0
    let fpsT0 = performance.now()

    window.addEventListener('resize', () => this.onResize())
    this.renderer.setAnimationLoop(() => {
      this.controls.update()
      const post = (this.aoEnabled || this.bloomPass.enabled) && this.renderMode !== 'Wireframe'
      if (post) {
        this.aoPass.enabled = this.aoEnabled
        this.composer.render()
      } else {
        this.renderer.render(this.scene, this.camera)
      }
      frames++
      const now = performance.now()
      if (now - fpsT0 >= 500) {
        if (this.fpsElement) {
          this.fpsElement.textContent = `${Math.round(frames * 1000 / (now - fpsT0))} FPS`
        }
        frames = 0
        fpsT0 = now
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
        distanceExponent: 1.5,
        thickness: 2,
        scale: 1.5,
        samples: 32,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      })
    }
  }

  setBloom({ enabled, strength, threshold, radius }) {
    if (enabled !== undefined) this.bloomPass.enabled = enabled
    if (strength !== undefined) this.bloomPass.strength = strength
    if (threshold !== undefined) this.bloomPass.threshold = threshold
    if (radius !== undefined) this.bloomPass.radius = radius
  }

  setExposure(value) {
    this.renderer.toneMappingExposure = value
  }

  setAntialias(enabled) {
    this.smaaPass.enabled = enabled
  }

  // Apply/remove the baked AO lightmap on the shared body materials
  setAOMap(texture) {
    for (const mode of ['Simple', 'PBR (HDR)']) {
      this.materials[mode].aoMap = texture
      this.materials[mode].needsUpdate = true
    }
  }

  setAOMapIntensity(value) {
    for (const mode of ['Simple', 'PBR (HDR)']) {
      this.materials[mode].aoMapIntensity = value
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

  // Cartridge plastic PBR parameters (independent of the sticker material)
  setPlasticParams(params) {
    Object.assign(this.materials['PBR (HDR)'], params)
    this.materials['PBR (HDR)'].needsUpdate = true
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
      if (obj.isMesh && !obj.userData.isGizmo && !obj.userData.isSticker) {
        obj.material = mat
        obj.castShadow = shadows
        obj.receiveShadow = shadows
        // force re-upload in case shadow flags changed
        obj.material.needsUpdate = true
      }
    })
  }
}
