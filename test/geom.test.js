import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as geom from '../src/geom.js'
import * as parity from '../src/parity.js'
import { mkTemp } from './helpers.js'

/** Two parallel tracks, `gap` apart, on the same layer and different nets. */
function board(gap) {
  const b = {
    name: 't', size: [20, 20], outline: [[0, 0], [20, 0], [20, 20], [0, 20]],
    rules: { clearance: 0.2, min_track: 0.25, min_annular: 0.15, edge_clearance: 0.3 },
    shapes: [], pads: [], tracks: [], vias: [],
  }
  b.shapes.push({ kind: 'track', net: 'A', layers: ['F.Cu'], poly: geom.segPoly(2, 10, 8, 10, 0.3), ref: 'a' })
  b.shapes.push({ kind: 'track', net: 'B', layers: ['F.Cu'], poly: geom.segPoly(2, 10 + gap, 8, 10 + gap, 0.3), ref: 'b' })
  return b
}

test('clearance violation is detected with a distance', () => {
  const res = geom.checkClearance(board(0.2))
  assert.ok(res.count >= 1)
  assert.ok(res.violations[0].actual_mm < 0.2)
})

test('adjacent tracks at exactly the limit pass', () => {
  assert.equal(geom.checkClearance(board(0.5)).count, 0)
})

test('same net never violates clearance', () => {
  const b = board(0.01)
  b.shapes[1].net = 'A'
  assert.equal(geom.checkClearance(b).count, 0)
})

test('annular ring below the rule is flagged', () => {
  const b = board(5)
  b.vias.push({ x: 5, y: 5, size: 0.5, drill: 0.3 })
  assert.equal(geom.checkAnnularRing(b).count, 1)
})

test('track narrower than the rule is flagged', () => {
  const b = board(5)
  b.tracks.push({ width: 0.1, net: 'A', x1: 1, y1: 1, x2: 2, y2: 1 })
  assert.equal(geom.checkTrackWidth(b).count, 1)
})

test('copper too close to the edge is flagged', () => {
  const b = board(5)
  b.shapes.push({ kind: 'track', net: 'C', layers: ['F.Cu'], poly: geom.segPoly(0.05, 5, 3, 5, 0.2), ref: 'c' })
  assert.equal(geom.checkEdgeClearance(b).count, 1)
})

test('floating pad is flagged, connected pad is not', () => {
  const b = {
    name: 't', size: [20, 20], outline: [], rules: {},
    shapes: [{ kind: 'track', net: 'GND', layers: ['F.Cu'], poly: geom.segPoly(0, 0, 5, 0, 0.3) }],
    pads: [
      { ref: 'R1', pad: '1', x: 2.5, y: 0, net: 'GND' },
      { ref: 'R1', pad: '2', x: 9, y: 9, net: 'GND' },
    ],
    tracks: [], vias: [],
  }
  const res = geom.checkUnconnected(b)
  assert.equal(res.count, 1)
  assert.equal(res.violations[0].pad, 'R1.2')
})

test('netlist mismatch is detected', () => {
  const netlist = { nets: [{ name: 'GND', pads: [['R1', '1'], ['R2', '1']] }] }
  const b = {
    pads: [{ ref: 'R1', pad: '1', net: 'GND' }, { ref: 'R2', pad: '1', net: '3V3' }],
    shapes: [{ kind: 'track', net: 'GND' }, { kind: 'track', net: '3V3' }],
  }
  const res = parity.netlistVsBoard(netlist, b)
  assert.ok(res.count >= 1)
})

test('a dropped track is caught by export parity', () => {
  const { dir, cleanup } = mkTemp('parity')
  try {
    const path = join(dir, 'b.kicad_pcb')
    writeFileSync(path, '(kicad_pcb (version 1) (net 0 "") (net 1 "GND")\n  (segment (start 0 0) (end 1 0) (width 0.3) (layer "F.Cu") (net 1)))\n', 'utf8')
    const model = { shapes: [
      { kind: 'track', net: 'GND', layers: ['F.Cu'], poly: geom.segPoly(0, 0, 1, 0, 0.3) },
      { kind: 'track', net: 'GND', layers: ['F.Cu'], poly: geom.segPoly(0, 2, 1, 2, 0.3) },
    ] }
    const res = parity.modelVsExport(model, geom.loadKicadPcb(path))
    assert.equal(res.count, 1)
    assert.match(res.problems[0], /missing from export/)
  } finally { cleanup() }
})

test('s-expression reader handles quoted strings and nesting', () => {
  const tree = geom.parseSexpr('(footprint "pcbh:X" (pad "1" smd rect (at 1 2) (size 1 1)))')
  assert.equal(tree[0], 'footprint')
  assert.equal(tree[1], 'pcbh:X')
  assert.equal(tree[2][0], 'pad')
  assert.equal(tree[2][1], '1')
})