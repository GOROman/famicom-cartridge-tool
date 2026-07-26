import * as THREE from 'three'
import GUI from 'lil-gui'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import { Viewer, RENDER_MODES } from './viewer.js'
import { Part } from './model.js'
import { FEATURE_TYPES, createFeature } from './features.js'
import { exportSTL } from './exporter.js'
import { RecessGizmoManager } from './gizmo.js'
import { StickerManager } from './sticker.js'
import { initManifold } from './csg.js'
import { bakeAOLightmap } from './aobake.js'

const BASE = import.meta.env.BASE_URL

// Base-model templates (all Creative Commons — Attribution)
const TEMPLATES = {
  'Dendy (5rw)': {
    top: 'models/Dendy_top.stl',
    bottom: 'models/Dendy_bottom.stl',
    credit: '"Dendy (Famicom) cartridge" by 5rw / CC BY',
    creditHTML: 'Base model: <a href="https://www.thingiverse.com/thing:3357677" target="_blank" rel="noopener">"Dendy (Famicom) cartridge"</a> by <a href="https://www.thingiverse.com/5rw" target="_blank" rel="noopener">5rw</a> / <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY</a>',
  },
  'Cartridge Case (Hot_Pixel)': {
    top: 'models/hotpixel_top.stl',
    bottom: 'models/hotpixel_bottom.stl',
    credit: '"Famicom (Dendy) Cartridge Case" by Hot_Pixel / CC BY',
    creditHTML: 'Base model: <a href="https://www.thingiverse.com/thing:5240914" target="_blank" rel="noopener">"Famicom (Dendy) Cartridge Case"</a> by <a href="https://www.thingiverse.com/Hot_Pixel" target="_blank" rel="noopener">Hot_Pixel</a> / <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY</a>',
  },
  'Everdrive N8 Shell (hadessuk)': {
    top: 'models/n8_front.stl',
    bottom: 'models/n8_back.stl',
    credit: '"Shell for Famicom Everdrive N8" by hadessuk / CC BY',
    creditHTML: 'Base model: <a href="https://www.printables.com/model/227423-shell-for-famicom-everdrive-n8-with-usb-port" target="_blank" rel="noopener">"Shell for Famicom Everdrive N8"</a> by <a href="https://www.printables.com/@hadessuk" target="_blank" rel="noopener">hadessuk</a> / <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY</a>',
  },
}
const statusEl = document.getElementById('status')
const viewer = new Viewer(document.getElementById('app'))

const parts = {
  Top: new Part('Top'),
  Bottom: new Part('Bottom'),
}

// Display-only transforms — exports stay in model space. The shells' outer
// surfaces face −Z in the STL, so flip them over to show the outside up.
const PART_GAP = 76
parts.Top.mesh.position.y = PART_GAP / 2
parts.Bottom.mesh.position.y = -PART_GAP / 2
function applyDisplayTransform(part) {
  part.mesh.rotation.x = Math.PI
  part.mesh.position.z = part.bounds.max.z
  if (settings?.assemble) setAssemblyPose(1)
}

// ---------- Assembly preview ----------
// Phased, collision-free choreography (mix 0 = exploded, 1 = standing cart):
//  1. bottom flips onto its back at the centre while the top slides over it
//     at hover height
//  2. the top drops straight down and seats onto the bottom (rims overlap)
//  3. the closed cartridge tips up to stand on its front edge
const SEAT_OVERLAP = 2 // mm of rim engagement when fully seated
function setAssemblyPose(mix) {
  const topH = parts.Top.bounds.max.z || 0
  const botH = parts.Bottom.bounds.max.z || 0
  const ph = (a, b) => {
    const u = Math.min(1, Math.max(0, (mix - a) / (b - a)))
    return u * u * (3 - 2 * u)
  }
  const f1 = ph(0, 0.34)    // flip + slide to centre
  const f2 = ph(0.36, 0.58) // top drops and seats
  const f3 = ph(0.64, 1)    // stand up

  const hoverZ = botH + topH + 16
  const seatZ = botH + topH - SEAT_OVERLAP

  parts.Bottom.mesh.quaternion.slerpQuaternions(Q_FLIPPED, Q_ASSEMBLED, f1)
  const bp = new THREE.Vector3(0, -PART_GAP / 2 * (1 - f1), botH * (1 - f1))

  parts.Top.mesh.quaternion.copy(Q_FLIPPED)
  const tp = new THREE.Vector3(0, PART_GAP / 2 * (1 - f1),
    topH + (hoverZ - topH) * f1 - (hoverZ - seatZ) * f2)

  if (f3 > 0) {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -f3 * Math.PI / 2)
    const pivot = new THREE.Vector3(0, parts.Bottom.bounds.max.y, 0)
    // once upright, slide the cart so it stands centred on the origin
    const originShift = -(pivot.y + seatZ / 2) * f3
    for (const [mesh, p] of [[parts.Bottom.mesh, bp], [parts.Top.mesh, tp]]) {
      p.sub(pivot).applyQuaternion(q).add(pivot)
      p.y += originShift
      mesh.quaternion.premultiply(q)
    }
  }
  parts.Bottom.mesh.position.copy(bp)
  parts.Top.mesh.position.copy(tp)
}
const Q_FLIPPED = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0))
const Q_ASSEMBLED = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI))

let assemblyAnim = null
function animateAssembly(toAssembled) {
  if (assemblyAnim) cancelAnimationFrame(assemblyAnim.raf)
  const from = assemblyAnim ? assemblyAnim.mix : (toAssembled ? 0 : 1)
  const start = performance.now()
  const DURATION = 1300
  const step = (now) => {
    const t = Math.min(1, (now - start) / DURATION)
    const mix = toAssembled ? from + (1 - from) * t : from * (1 - t)
    setAssemblyPose(mix)
    assemblyAnim.mix = mix
    if (t < 1) assemblyAnim.raf = requestAnimationFrame(step)
    else assemblyAnim = null
  }
  assemblyAnim = { mix: from, raf: requestAnimationFrame(step) }
}
viewer.modelGroup.add(parts.Top.mesh, parts.Bottom.mesh)

let font = null
let bakeInProgress = false
let bakedTexture = null

const featureFolderById = new Map()
const stickerMgr = new StickerManager()
const gizmoMgr = new RecessGizmoManager(viewer, {
  onChange: (part, f) => {
    featureFolderById.get(f.id)?.controllersRecursive().forEach((c) => c.updateDisplay())
    rebuild(part)
  },
  onCommit: (part) => rebuild(part, true),
})

const settings = {
  renderMode: viewer.renderMode,
  shadows: true,
  ao: false,
  aoRadius: 6,
  aoIntensity: 1.5,
  exposure: 1,
  antialias: true,
  bakeSamples: 16,
  bakeResolution: 1024,
  bakedAO: false,
  bakedAOIntensity: 1,
  bakeAONow: async () => {
    if (bakeInProgress) return
    bakeInProgress = true
    const box = document.getElementById('bake-progress')
    const label = document.getElementById('bake-label')
    const pct = document.getElementById('bake-pct')
    const bar = document.getElementById('bake-bar')
    box.classList.add('active')
    label.textContent = `Baking AO lightmap — ${settings.bakeResolution}px, ${settings.bakeSamples} samples`
    try {
      const targets = Object.values(parts).filter((p) => p.baseGeometry)
      const tex = await bakeAOLightmap(targets.map((p) => p.mesh.geometry), {
        resolution: settings.bakeResolution,
        samples: settings.bakeSamples,
        onProgress: (p) => {
          pct.textContent = `${Math.round(p * 100)}%`
          bar.style.width = `${Math.round(p * 100)}%`
        },
      })
      bakedTexture?.dispose()
      bakedTexture = tex
      settings.bakedAO = true
      viewer.setAOMap(tex)
      viewer.setAOMapIntensity(settings.bakedAOIntensity)
      gui.controllersRecursive().forEach((c) => c.updateDisplay())
      setStatus(`Baked AO lightmap applied (${settings.bakeResolution}px, ${(tex.userData.bakeMs / 1000).toFixed(1)}s)`)
    } catch (err) {
      console.error(err)
      viewer.setAOMap(null)
      setStatus(`AO bake failed: ${err.message}`)
    } finally {
      bakeInProgress = false
      box.classList.remove('active')
      bar.style.width = '0%'
    }
  },
  bloom: false,
  bloomStrength: 0.25,
  bloomThreshold: 1.0,
  bloomRadius: 0.3,
  bodyColor: '#d8b25a',
  plasticRoughness: 0.45,
  plasticClearcoat: 0.15,
  stickerRoughness: 0.35,
  stickerClearcoat: 0.4,
  envBackground: false,
  hdriPreset: 'Room (Default)',
  activePart: 'Top',
  template: 'Dendy (5rw)',
  showTop: true,
  showBottom: true,
  assemble: false,
  loadTopSTL: () => pickFile('.stl', (buf) => { parts.Top.loadArrayBuffer(buf); applyDisplayTransform(parts.Top); rebuild(parts.Top) }),
  loadBottomSTL: () => pickFile('.stl', (buf) => { parts.Bottom.loadArrayBuffer(buf); applyDisplayTransform(parts.Bottom); rebuild(parts.Bottom) }),
  loadHDR: () => pickFile('.hdr', null, async (file) => {
    await viewer.loadHDR(URL.createObjectURL(file))
    setStatus(`HDR environment loaded: ${file.name}`)
  }),
  resetBase: async () => { await loadTemplate(settings.template); rebuildAll() },
  exportTop: () => doExport(['Top']),
  exportBottom: () => doExport(['Bottom']),
  exportBoth: () => doExport(['Top', 'Bottom']),
  addFeatureType: 'Groove',
  addFeature: () => {
    const part = parts[settings.activePart]
    if (!part.baseGeometry) return setStatus('Load a base STL first')
    const f = createFeature(settings.addFeatureType, part.bounds)
    part.features.push(f)
    addFeatureFolder(part, f)
    rebuild(part)
  },
}

function setStatus(msg) {
  const tri = (p) => p.baseGeometry ? `${p.name}: ${p.triangleCount.toLocaleString()} tris` : ''
  statusEl.textContent = [msg, tri(parts.Top), tri(parts.Bottom)].filter(Boolean).join('  |  ')
}

function pickFile(accept, onBuffer, onFile) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = async () => {
    const file = input.files[0]
    if (!file) return
    if (onFile) return onFile(file)
    onBuffer(await file.arrayBuffer(), file)
  }
  input.click()
}

let rebuildTimer = null
function rebuild(part, immediate = false) {
  clearTimeout(rebuildTimer)
  const run = () => {
    part.rebuild(font)
    viewer.applyRenderMode()
    if (bakedTexture) {
      // geometry changed — atlas UVs and lightmap are stale
      bakedTexture.dispose()
      bakedTexture = null
      viewer.setAOMap(null)
      if (settings.bakedAO) {
        settings.bakedAO = false
        gui.controllersRecursive().forEach((c) => c.updateDisplay())
        setStatus(`${part.name} rebuilt in ${part.lastBuildMs.toFixed(0)} ms — baked AO cleared, re-bake if needed`)
        return
      }
    }
    setStatus(`${part.name} rebuilt in ${part.lastBuildMs.toFixed(0)} ms`)
  }
  if (immediate) run()
  else rebuildTimer = setTimeout(run, 200)
}

function rebuildAll() {
  for (const p of Object.values(parts)) p.rebuild(font)
  viewer.applyRenderMode()
  if (bakedTexture) {
    bakedTexture.dispose()
    bakedTexture = null
    viewer.setAOMap(null)
    settings.bakedAO = false
    gui?.controllersRecursive().forEach((c) => c.updateDisplay())
  }
  setStatus('Rebuilt')
}

function doExport(names) {
  const geos = []
  let offset = 0
  for (const name of names) {
    const p = parts[name]
    if (!p.baseGeometry) continue
    const g = (p.exportGeometry ?? p.mesh.geometry).clone()
    if (names.length > 1) {
      g.translate(0, offset, 0)
      offset -= PART_GAP
    }
    geos.push(g)
  }
  if (!geos.length) return setStatus('Nothing to export')
  const name = names.length > 1 ? 'cartridge_both.stl' : `cartridge_${names[0].toLowerCase()}.stl`
  exportSTL(geos, name)
  setStatus(`Exported ${name}`)
}

// ---------- GUI ----------
const gui = new GUI({ title: 'Famicom Cartridge Tool', width: 320 })

const fView = gui.addFolder('Rendering')
fView.add(settings, 'renderMode', RENDER_MODES).name('Mode').onChange((v) => viewer.setRenderMode(v))
fView.add(settings, 'shadows').name('Shadows').onChange((v) => viewer.setShadows(v))
fView.add(settings, 'ao').name('Ambient Occlusion').onChange((v) => viewer.setAO(v))
fView.add(settings, 'aoRadius', 0.5, 20, 0.5).name('AO Radius (mm)').onChange((v) => viewer.setAOParams({ radius: v }))
fView.add(settings, 'aoIntensity', 0, 3, 0.05).name('AO Intensity').onChange((v) => viewer.setAOParams({ intensity: v }))
fView.add(settings, 'exposure', 0.1, 3, 0.05).name('Exposure').onChange((v) => viewer.setExposure(v))
fView.add(settings, 'antialias').name('Anti-Aliasing (SMAA)').onChange((v) => viewer.setAntialias(v))

const fBake = fView.addFolder('Baked AO (Lightmap)')
fBake.add(settings, 'bakeResolution', [512, 1024, 2048]).name('Resolution (px)')
fBake.add(settings, 'bakeSamples', 8, 64, 8).name('Samples')
fBake.add(settings, 'bakedAOIntensity', 0, 2, 0.05).name('Intensity').onChange((v) => viewer.setAOMapIntensity(v))
fBake.add(settings, 'bakeAONow').name('⚡ Bake AO Now')
fBake.add(settings, 'bakedAO').name('Use Baked AO').onChange((v) => {
  if (!v) {
    viewer.setAOMap(null)
    return
  }
  if (bakedTexture) {
    viewer.setAOMap(bakedTexture)
    viewer.setAOMapIntensity(settings.bakedAOIntensity)
  } else {
    // no lightmap yet — bake first, aoMap switches on when it completes
    settings.bakedAO = false
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
    settings.bakeAONow()
  }
})
fBake.close()
fView.add(settings, 'bloom').name('Bloom').onChange((v) => viewer.setBloom({ enabled: v }))
fView.add(settings, 'bloomStrength', 0, 1.5, 0.05).name('Bloom Strength').onChange((v) => viewer.setBloom({ strength: v }))
fView.add(settings, 'bloomThreshold', 0, 2, 0.01).name('Bloom Threshold').onChange((v) => viewer.setBloom({ threshold: v }))
fView.add(settings, 'bloomRadius', 0, 1, 0.01).name('Bloom Radius').onChange((v) => viewer.setBloom({ radius: v }))
fView.addColor(settings, 'bodyColor').name('Body Color').onChange((v) => viewer.setBodyColor(v))

const fMat = fView.addFolder('Materials (PBR)')
fMat.add(settings, 'plasticRoughness', 0, 1, 0.01).name('Plastic Roughness').onChange((v) => viewer.setPlasticParams({ roughness: v }))
fMat.add(settings, 'plasticClearcoat', 0, 1, 0.01).name('Plastic Clearcoat').onChange((v) => viewer.setPlasticParams({ clearcoat: v }))
fMat.add(settings, 'stickerRoughness', 0, 1, 0.01).name('Sticker Roughness').onChange((v) => stickerMgr.setMaterialParams({ roughness: v }))
fMat.add(settings, 'stickerClearcoat', 0, 1, 0.01).name('Sticker Clearcoat').onChange((v) => stickerMgr.setMaterialParams({ clearcoat: v }))
fMat.close()
const HDRI_PRESETS = {
  'Room (Default)': null,
  'Studio': 'studio_small_03_2k.hdr',
  'Sunrise': 'spruit_sunrise_2k.hdr',
  'Sunset': 'venice_sunset_2k.hdr',
  'Night': 'moonless_golf_2k.hdr',
}
fView.add(settings, 'hdriPreset', Object.keys(HDRI_PRESETS)).name('HDRI Preset').onChange(async (v) => {
  const file = HDRI_PRESETS[v]
  if (!file) { viewer.clearHDR(); setStatus('Environment: procedural room'); return }
  setStatus(`Loading HDRI: ${v}…`)
  await viewer.loadHDR(`${BASE}hdri/${file}`)
  setStatus(`Environment: ${v}`)
})
fView.add(settings, 'envBackground').name('HDR Background').onChange((v) => viewer.setEnvBackground(v))
fView.add(settings, 'loadHDR').name('Load Custom HDR…')

const fParts = gui.addFolder('Parts')
fParts.add(settings, 'template', Object.keys(TEMPLATES)).name('Template').onChange(async (name) => {
  setStatus(`Loading template: ${name}…`)
  await loadTemplate(name)
  syncDendyFillFeatures(name)
  rebuildAll()
})
fParts.add(settings, 'showTop').name('Show Top').onChange((v) => { parts.Top.mesh.visible = v && !!parts.Top.baseGeometry })
fParts.add(settings, 'assemble').name('Assembly Preview').onChange((v) => {
  animateAssembly(v)
  gizmoMgr.setAllVisible(!v)
})
fParts.add(settings, 'showBottom').name('Show Bottom').onChange((v) => { parts.Bottom.mesh.visible = v && !!parts.Bottom.baseGeometry })
fParts.add(settings, 'loadTopSTL').name('Import Top STL…')
fParts.add(settings, 'loadBottomSTL').name('Import Bottom STL…')
fParts.add(settings, 'resetBase').name('Reset to Dendy Base')

const fFeat = gui.addFolder('Features')
fFeat.add(settings, 'activePart', ['Top', 'Bottom']).name('Edit Part')
fFeat.add(settings, 'addFeatureType', FEATURE_TYPES).name('Feature Type')
fFeat.add(settings, 'addFeature').name('+ Add Feature')

const featureFolders = { Top: fFeat.addFolder('Top Features'), Bottom: fFeat.addFolder('Bottom Features') }

const fExport = gui.addFolder('Export')
fExport.add(settings, 'exportTop').name('Export Top STL')
fExport.add(settings, 'exportBottom').name('Export Bottom STL')
fExport.add(settings, 'exportBoth').name('Export Both STL')

function addFeatureFolder(part, f) {
  const folder = featureFolders[part.name].addFolder(f.name)
  featureFolderById.set(f.id, folder)
  const isRecess = f.type === 'Label Recess'
  const isSticker = f.type === 'Sticker'
  const on = () => {
    if (isRecess) gizmoMgr.refresh(f)
    if (isSticker) {
      if (f.lockAspect && f._aspect) {
        f.height = f.width / f._aspect
        folder.controllersRecursive().forEach((c) => c.updateDisplay())
      }
      stickerMgr.update(part, f)
      return
    }
    rebuild(part)
  }
  if (isRecess) gizmoMgr.attach(part, f)
  folder.add(f, 'enabled').name('Enabled').onChange((v) => {
    if (isRecess) gizmoMgr.setVisible(f, v && !settings.assemble)
    if (isSticker) return stickerMgr.update(part, f)
    rebuild(part)
  })

  const num = (key, label, min, max, step = 0.1) =>
    folder.add(f, key, min, max, step).name(label).onChange(on)

  switch (f.type) {
    case 'Groove':
      folder.add(f, 'axis', ['X', 'Y']).name('Along Axis').onChange(on)
      folder.add(f, 'face', { 'Outer (-Z)': 'Bottom', 'Inner (+Z)': 'Top' }).name('Cut Face').onChange(on)
      num('position', 'Position', -55, 55)
      num('count', 'Count', 1, 20, 1)
      num('spacing', 'Spacing', 1, 40)
      num('width', 'Width', 0.2, 20)
      num('depth', 'Depth', 0.1, 8)
      num('length', 'Length (0=full)', 0, 120)
      break
    case 'Label Recess':
      folder.add(f, 'face', { 'Outer (-Z)': 'Bottom', 'Inner (+Z)': 'Top' }).name('Face').onChange(on)
      num('width', 'Width', 5, 105)
      num('height', 'Height', 5, 66)
      num('cornerRadius', 'Corner Radius', 0, 20)
      num('x', 'X', -50, 50)
      num('y', 'Y', -30, 30)
      num('depth', 'Depth', 0.1, 5)
      break
    case 'Box':
      folder.add(f, 'op', ['Subtract', 'Add']).name('Operation').onChange(on)
      num('sizeX', 'Size X', 0.5, 120)
      num('sizeY', 'Size Y', 0.5, 80)
      num('sizeZ', 'Size Z', 0.5, 30)
      num('x', 'X', -60, 60)
      num('y', 'Y', -40, 40)
      num('z', 'Z', -10, 20)
      num('rotZ', 'Rotation Z°', -180, 180, 1)
      break
    case 'Cylinder':
      folder.add(f, 'op', ['Subtract', 'Add']).name('Operation').onChange(on)
      folder.add(f, 'axis', ['X', 'Y', 'Z']).name('Axis').onChange(on)
      num('radius', 'Radius', 0.2, 40)
      num('height', 'Height', 0.5, 130)
      num('x', 'X', -60, 60)
      num('y', 'Y', -40, 40)
      num('z', 'Z', -10, 20)
      break
    case 'Text':
      folder.add(f, 'op', ['Engrave', 'Emboss']).name('Operation').onChange(on)
      folder.add(f, 'face', { 'Outer (-Z)': 'Bottom', 'Inner (+Z)': 'Top' }).name('Face').onChange(on)
      folder.add(f, 'text').name('Text').onChange(on)
      num('size', 'Size', 2, 30)
      num('depth', 'Depth', 0.2, 3)
      num('x', 'X', -50, 50)
      num('y', 'Y', -30, 30)
      num('rotZ', 'Rotation°', -180, 180, 1)
      break
    case 'Sticker':
      folder.add({ load: () => pickFile('.png,.jpg,.jpeg,.webp', null, async (file) => {
        await stickerMgr.setImage(part, f, URL.createObjectURL(file), file.name)
        folder.controllersRecursive().forEach((c) => c.updateDisplay())
        setStatus(`Sticker image: ${file.name} (display only, not exported)`)
      }) }, 'load').name('Load Image (PNG/JPG)…')
      folder.add(f, 'face', { 'Outer (-Z)': 'Bottom', 'Inner (+Z)': 'Top' }).name('Face').onChange(on)
      folder.add(f, 'lockAspect').name('Lock Aspect').onChange(on)
      num('width', 'Width', 5, 110)
      num('height', 'Height', 5, 70)
      num('cornerRadius', 'Corner Radius', 0, 25)
      num('x', 'X', -50, 50)
      num('y', 'Y', -30, 30)
      num('rotZ', 'Rotation°', -180, 180, 1)
      num('opacity', 'Opacity', 0, 1, 0.01)
      break
  }
  folder.add({ remove: () => {
    part.features.splice(part.features.indexOf(f), 1)
    if (isRecess) gizmoMgr.detach(f)
    if (isSticker) stickerMgr.remove(f)
    featureFolderById.delete(f.id)
    folder.destroy()
    rebuild(part)
  } }, 'remove').name('✕ Remove')
}

// ---------- Drag & drop ----------
const dropHint = document.getElementById('drop-hint')
window.addEventListener('dragover', (e) => { e.preventDefault(); dropHint.style.display = 'flex' })
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dropHint.style.display = 'none' })
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropHint.style.display = 'none'
  const file = e.dataTransfer.files[0]
  if (!file) return
  if (/\.hdr$/i.test(file.name)) {
    await viewer.loadHDR(URL.createObjectURL(file))
    setStatus(`HDR environment loaded: ${file.name}`)
  } else if (/\.stl$/i.test(file.name)) {
    const part = parts[settings.activePart]
    part.loadArrayBuffer(await file.arrayBuffer())
    applyDisplayTransform(part)
    rebuild(part, true)
    setStatus(`Imported ${file.name} into ${part.name}`)
  } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const part = parts[settings.activePart]
    let f = part.features.findLast((x) => x.type === 'Sticker')
    if (!f) {
      f = createFeature('Sticker', part.bounds)
      part.features.push(f)
      addFeatureFolder(part, f)
    }
    await stickerMgr.setImage(part, f, URL.createObjectURL(file), file.name)
    featureFolderById.get(f.id)?.controllersRecursive().forEach((c) => c.updateDisplay())
    setStatus(`Sticker image: ${file.name} on ${part.name} (display only, not exported)`)
  }
})

// ---------- Startup ----------
const loadingEl = document.getElementById('loading')
const loadingBar = document.getElementById('loading-bar')
const loadingStep = document.getElementById('loading-step')
const progress = { wasm: 0, top: 0, bottom: 0, font: 0 }
const WEIGHTS = { wasm: 0.2, top: 0.3, bottom: 0.35, font: 0.15 }
function reportProgress(key, frac, label) {
  progress[key] = Math.min(1, frac)
  let total = 0
  for (const k of Object.keys(WEIGHTS)) total += WEIGHTS[k] * progress[k]
  loadingBar.style.width = `${Math.round(total * 100)}%`
  if (label) loadingStep.textContent = label
}
const onFileProgress = (key, label) => (e) => {
  if (e.total) reportProgress(key, e.loaded / e.total, label)
}

async function loadTemplate(name) {
  const t = TEMPLATES[name]
  await Promise.all([
    parts.Top.loadURL(`${BASE}${t.top}`,
      onFileProgress('top', `Loading ${t.top}…`)).then(() => reportProgress('top', 1)),
    parts.Bottom.loadURL(`${BASE}${t.bottom}`,
      onFileProgress('bottom', `Loading ${t.bottom}…`)).then(() => reportProgress('bottom', 1)),
  ])
  applyDisplayTransform(parts.Top)
  applyDisplayTransform(parts.Bottom)
  document.getElementById('credit').innerHTML = t.creditHTML
  setStatus(`Template: ${name} — ${t.credit}`)
}

// The Dendy base shells have moulded 0.5 mm label recesses; fill features
// flatten them so label areas are fully parametric. They only make sense for
// the Dendy template, so add/remove them when the template changes.
function syncDendyFillFeatures(templateName) {
  const isDendy = templateName === 'Dendy (5rw)'
  for (const part of Object.values(parts)) {
    for (const f of [...part.features]) {
      if (!f._dendyFill) continue
      part.features.splice(part.features.indexOf(f), 1)
      featureFolderById.get(f.id)?.destroy()
      featureFolderById.delete(f.id)
    }
  }
  if (!isDendy) return
  const specs = [
    [parts.Top, { sizeX: 96, sizeY: 56.6, sizeZ: 2, x: 0, y: 5.1, z: 1, rotZ: 0 }],
    [parts.Bottom, { sizeX: 107.4, sizeY: 46.8, sizeZ: 2, x: 0, y: 7.5, z: 1, rotZ: 0 }],
  ]
  for (const [part, dims] of specs) {
    const fill = Object.assign(createFeature('Box', part.bounds), {
      name: 'Fill Base Label Area', op: 'Add', _dendyFill: true, ...dims,
    })
    part.features.push(fill)
    addFeatureFolder(part, fill)
  }
}

async function init() {
  setStatus('Loading…')
  viewer.fpsElement = document.getElementById('fps')
  const fontPromise = new FontLoader()
    .loadAsync(`${BASE}fonts/helvetiker_bold.typeface.json`, onFileProgress('font', 'Loading font…'))
    .then((f) => { reportProgress('font', 1); return f })

  reportProgress('wasm', 0.1, 'Initialising CSG engine (Manifold)…')
  await initManifold()
  reportProgress('wasm', 1, 'Loading base models…')

  await loadTemplate(settings.template)
  syncDendyFillFeatures(settings.template)

  // Parametric label recess on the bottom shell's outer face
  const recess = createFeature('Label Recess', parts.Bottom.bounds)
  recess.name = 'Back Label Recess'
  parts.Bottom.features.push(recess)
  addFeatureFolder(parts.Bottom, recess)

  loadingStep.textContent = 'Building geometry…'
  rebuildAll()
  font = await fontPromise
  loadingEl.classList.add('done')
  setStatus('Ready')
}

window.app = { viewer, parts, setAssemblyPose, stickerMgr }

init().catch((err) => {
  console.error(err)
  setStatus(`Error: ${err.message}`)
  loadingStep.textContent = `Error: ${err.message}`
})
