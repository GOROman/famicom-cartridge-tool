import GUI from 'lil-gui'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import { Viewer, RENDER_MODES } from './viewer.js'
import { Part } from './model.js'
import { FEATURE_TYPES, createFeature } from './features.js'
import { exportSTL } from './exporter.js'
import { RecessGizmoManager } from './gizmo.js'

const BASE = import.meta.env.BASE_URL
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
// mix 0 = exploded side-by-side (outer faces up), 1 = closed cartridge:
// bottom shell flips onto its back and the top shell lands on top of it.
function setAssemblyPose(mix) {
  const ease = mix * mix * (3 - 2 * mix) // smoothstep
  const topH = parts.Top.bounds.max.z || 0
  const botH = parts.Bottom.bounds.max.z || 0
  const lerp = (a, b) => a + (b - a) * ease

  parts.Top.mesh.rotation.x = Math.PI
  parts.Top.mesh.position.set(0, lerp(PART_GAP / 2, 0), lerp(topH, botH + topH))
  parts.Bottom.mesh.rotation.x = lerp(Math.PI, 0)
  parts.Bottom.mesh.position.set(0, lerp(-PART_GAP / 2, 0), lerp(botH, 0))
}

let assemblyAnim = null
function animateAssembly(toAssembled) {
  if (assemblyAnim) cancelAnimationFrame(assemblyAnim.raf)
  const from = assemblyAnim ? assemblyAnim.mix : (toAssembled ? 0 : 1)
  const start = performance.now()
  const DURATION = 900
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

const featureFolderById = new Map()
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
  ao: true,
  aoRadius: 4,
  aoIntensity: 1,
  bodyColor: '#d8b25a',
  envBackground: false,
  hdriPreset: 'Room (Default)',
  activePart: 'Top',
  showTop: true,
  showBottom: true,
  assemble: false,
  loadTopSTL: () => pickFile('.stl', (buf) => { parts.Top.loadArrayBuffer(buf); applyDisplayTransform(parts.Top); rebuild(parts.Top) }),
  loadBottomSTL: () => pickFile('.stl', (buf) => { parts.Bottom.loadArrayBuffer(buf); applyDisplayTransform(parts.Bottom); rebuild(parts.Bottom) }),
  loadHDR: () => pickFile('.hdr', null, async (file) => {
    await viewer.loadHDR(URL.createObjectURL(file))
    setStatus(`HDR environment loaded: ${file.name}`)
  }),
  resetBase: async () => { await loadDefaults(); rebuildAll() },
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
    setStatus(`${part.name} rebuilt in ${part.lastBuildMs.toFixed(0)} ms`)
  }
  if (immediate) run()
  else rebuildTimer = setTimeout(run, 200)
}

function rebuildAll() {
  for (const p of Object.values(parts)) p.rebuild(font)
  viewer.applyRenderMode()
  setStatus('Rebuilt')
}

function doExport(names) {
  const geos = []
  let offset = 0
  for (const name of names) {
    const p = parts[name]
    if (!p.baseGeometry) continue
    const g = p.mesh.geometry.clone()
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
fView.add(settings, 'aoIntensity', 0, 2, 0.05).name('AO Intensity').onChange((v) => viewer.setAOParams({ intensity: v }))
fView.addColor(settings, 'bodyColor').name('Body Color').onChange((v) => viewer.setBodyColor(v))
const HDRI_PRESETS = {
  'Room (Default)': null,
  'Studio': 'studio_small_03_1k.hdr',
  'Sunrise': 'spruit_sunrise_1k.hdr',
  'Sunset': 'venice_sunset_1k.hdr',
  'Night': 'moonless_golf_1k.hdr',
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
  const on = () => {
    if (isRecess) gizmoMgr.refresh(f)
    rebuild(part)
  }
  if (isRecess) gizmoMgr.attach(part, f)
  folder.add(f, 'enabled').name('Enabled').onChange((v) => {
    if (isRecess) gizmoMgr.setVisible(f, v && !settings.assemble)
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
  }
  folder.add({ remove: () => {
    part.features.splice(part.features.indexOf(f), 1)
    if (isRecess) gizmoMgr.detach(f)
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
  }
})

// ---------- Startup ----------
async function loadDefaults() {
  await Promise.all([
    parts.Top.loadURL(`${BASE}models/Dendy_top.stl`),
    parts.Bottom.loadURL(`${BASE}models/Dendy_bottom.stl`),
  ])
  applyDisplayTransform(parts.Top)
  applyDisplayTransform(parts.Bottom)
}

async function init() {
  setStatus('Loading base models…')
  const fontPromise = new FontLoader().loadAsync(`${BASE}fonts/helvetiker_bold.typeface.json`)
  await loadDefaults()

  // Default feature setup: label recess on the bottom shell's outer face
  const recess = createFeature('Label Recess', parts.Bottom.bounds)
  recess.name = 'Back Label Recess'
  parts.Bottom.features.push(recess)
  addFeatureFolder(parts.Bottom, recess)

  rebuildAll()
  font = await fontPromise
  setStatus('Ready')
}

window.app = { viewer, parts }

init().catch((err) => {
  console.error(err)
  setStatus(`Error: ${err.message}`)
})
