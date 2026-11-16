import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePcb, writePcbExport } from '../src/boardgen.js'
import { loadBoard, loadKicadPcb } from '../src/geom.js'
import { modelVsExport } from '../src/parity.js'
import { defineTool } from './fake-sdk.js'
import { registerTools } from '../src/plugin.js'
import { fakeCtx, mkTemp, REPO } from './helpers.js'

const BOARD = join(REPO, 'examples', 'ldo3v3', 'hw', 'board.json')
const EXPORT = join(REPO, 'examples', 'ldo3v3', 'hw', 'board.kicad_pcb')

const model = () => JSON.parse(readFileSync(BOARD, 'utf8'))
const centroid = poly => {
  const [sx, sy] = poly.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0])
  return [sx / poly.length, sy / poly.length]
}

test('the generator is deterministic and reproduces the committed export', () => {
  assert.equal(generatePcb(model()), readFileSync(EXPORT, 'utf8'))
})

test('placement rotation is carried into the export', () => {
  const { dir, cleanup } = mkTemp('gen-rot')
  try {
    const { path } = writePcbExport(BOARD, join(dir, 'board.kicad_pcb'))
    const parsed = loadKicadPcb(path)
    const pad = parsed.shapes.find(s => s.ref === 'U1.1')
    assert.ok(pad, 'U1 pad 1 must be present')
    const [cx, cy] = centroid(pad.poly)
    // U1 sits at (28,13) rotated 180, so its pin 1 lands at (30.3,15.2) - not (25.7,10.8).
    assert.ok(Math.abs(cx - 30.3) < 0.011, `x was ${cx}`)
    assert.ok(Math.abs(cy - 15.2) < 0.011, `y was ${cy}`)
  } finally { cleanup() }
})

test('positional parity passes on the generated export', () => {
  const { dir, cleanup } = mkTemp('gen-parity')
  try {
    const { path } = writePcbExport(BOARD, join(dir, 'board.kicad_pcb'))
    const res = modelVsExport(loadBoard(BOARD), loadKicadPcb(path))
    assert.equal(res.count, 0, res.problems.join('; '))
    assert.equal(res.positional, true)
    assert.ok(res.model_items > 40)
  } finally { cleanup() }
})

test('a dropped placement rotation is caught positionally', () => {
  const data = model()
  data.placements.find(p => p.ref === 'U1').rot = 0
  const { dir, cleanup } = mkTemp('gen-drop')
  try {
    const path = join(dir, 'board.kicad_pcb')
    writeFileSync(path, generatePcb(data), 'utf8')
    const res = modelVsExport(loadBoard(BOARD), loadKicadPcb(path))
    assert.ok(res.count >= 2, 'a rotated part must produce at least two missing pads')
    assert.match(res.problems.join(' '), /U1/)
  } finally { cleanup() }
})

test('a 0.5 mm track shift is caught positionally', () => {
  const data = model()
  const route = data.routes.find(r => r.net === 'VIN')
  route.points = route.points.map(([x, y]) => [x, y + 0.5])
  const { dir, cleanup } = mkTemp('gen-shift')
  try {
    const path = join(dir, 'board.kicad_pcb')
    writeFileSync(path, generatePcb(data), 'utf8')
    const res = modelVsExport(loadBoard(BOARD), loadKicadPcb(path))
    assert.ok(res.count >= 1)
    assert.match(res.problems.join(' '), /VIN/)
  } finally { cleanup() }
})

test('the pcb_export tool writes an export the parity check accepts', async () => {
  const { ctx, registered } = fakeCtx()
  registerTools(ctx, { defineTool, config: {} })
  assert.ok(registered.has('pcb_export'))
  const { dir, cleanup } = mkTemp('gen-tool')
  try {
    const out = join(dir, 'export.kicad_pcb')
    const result = await registered.get('pcb_export').execute({ boardPath: BOARD, outPath: out })
    assert.equal(result.path, out)
    const res = modelVsExport(loadBoard(BOARD), loadKicadPcb(out))
    assert.equal(res.count, 0, res.problems.join('; '))
  } finally { cleanup() }
})