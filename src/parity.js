/**
 * Connectivity parity: netlist <-> board model, and board model <-> `.kicad_pcb` export.
 *
 * The export comparison is **positional**: coordinates are rounded to 0.01 mm and compared as a
 * multiset, so a part shifted by half a millimetre, a dropped placement rotation, or a track
 * nudged off its pad is caught. An earlier version compared only item counts and nets, and a
 * discarded 180-degree rotation slipped through every internal check - see
 * `examples/ldo3v3/hw/DRC-TRIAGE.md`.
 *
 * @module dsh-pcb/src/parity
 */
import { readFileSync } from 'node:fs'

/** @returns {object} parsed netlist artifact. */
export function loadNetlist(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Compare a netlist artifact against a loaded board model. */
export function netlistVsBoard(netlist, board) {
  const problems = []
  const nlPadNet = new Map()
  for (const net of netlist.nets ?? []) {
    for (const [ref, pad] of net.pads) {
      const key = `${ref}.${pad}`
      if (nlPadNet.has(key) && nlPadNet.get(key) !== net.name) {
        problems.push(`${key} assigned to two nets: ${nlPadNet.get(key)}, ${net.name}`)
      }
      nlPadNet.set(key, net.name)
    }
  }

  const bdPadNet = new Map()
  for (const pad of board.pads) bdPadNet.set(`${pad.ref}.${pad.pad}`, pad.net)

  for (const [key, net] of nlPadNet) {
    if (!bdPadNet.has(key)) problems.push(`${key} in netlist but not on the board`)
    else if (bdPadNet.get(key) !== net) {
      problems.push(`${key} net ${JSON.stringify(bdPadNet.get(key))} on board, ${JSON.stringify(net)} in netlist`)
    }
  }
  for (const [key, net] of bdPadNet) {
    if (!nlPadNet.has(key) && net) problems.push(`${key} on the board with net ${JSON.stringify(net)} but absent from the netlist`)
  }

  const nlNets = new Set((netlist.nets ?? []).map(n => n.name))
  const copperNets = new Set(board.shapes.filter(s => s.net).map(s => s.net))
  for (const net of [...copperNets].sort()) {
    if (!nlNets.has(net)) problems.push(`copper net ${JSON.stringify(net)} does not exist in the netlist`)
  }
  for (const net of [...nlNets].sort()) {
    const pads = [...bdPadNet].filter(([, n]) => n === net).map(([key]) => key)
    if (pads.length < 2) problems.push(`net ${JSON.stringify(net)} has ${pads.length} pad(s) - a net needs at least two`)
    if (!copperNets.has(net)) problems.push(`net ${JSON.stringify(net)} has no copper`)
  }

  return { check: 'netlist_vs_board', problems, count: problems.length, nets: nlNets.size, pads: nlPadNet.size }
}

/** Normalise a layer list to the copper layers it occupies (`*.Cu` means both sides). */
export function copperLayers(layers) {
  const out = new Set()
  for (const layer of layers ?? []) {
    if (layer === '*.Cu') {
      out.add('F.Cu')
      out.add('B.Cu')
    } else if (layer === 'F.Cu' || layer === 'B.Cu') {
      out.add(layer)
    }
  }
  return [...out].sort()
}

const q = (value, step) => {
  const n = Math.round(value / step) * step
  return (n === 0 ? 0 : n).toFixed(2)
}

/** Positional identity of one copper item: kind, net, copper layers and every vertex. */
export function shapeKey(shape, step = 0.01) {
  const points = shape.poly.map(([x, y]) => `${q(x, step)},${q(y, step)}`).join(' ')
  return `${shape.kind}|${shape.net}|${copperLayers(shape.layers).join('+')}|${points}`
}

const centroid = poly => {
  const sum = poly.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0])
  return [sum[0] / poly.length, sum[1] / poly.length]
}

const describe = shape => {
  const [cx, cy] = centroid(shape.poly)
  const ref = shape.ref ? ` [${shape.ref}]` : ''
  return `${shape.kind} net=${shape.net || '(none)'} at (${q(cx, 0.01)}, ${q(cy, 0.01)})${ref}`
}

function indexByKey(board, kinds, step) {
  const map = new Map()
  for (const shape of board.shapes) {
    if (!kinds.includes(shape.kind) || !shape.net) continue
    const key = shapeKey(shape, step)
    const entry = map.get(key)
    if (entry) entry.count += 1
    else map.set(key, { count: 1, shape })
  }
  return map
}

const total = map => [...map.values()].reduce((sum, entry) => sum + entry.count, 0)

/**
 * Compare the exported copper against the model **by position**.
 * @param {object} model - board loaded from `board.json`.
 * @param {object} exportBoard - board parsed from `.kicad_pcb`.
 * @param {{kinds?: string[], stepMm?: number}} [options]
 */
export function modelVsExport(model, exportBoard, options = {}) {
  const kinds = options.kinds ?? ['track', 'pad', 'via']
  const step = options.stepMm ?? 0.01
  const m = indexByKey(model, kinds, step)
  const e = indexByKey(exportBoard, kinds, step)
  const problems = []

  for (const [key, entry] of m) {
    const other = e.get(key)
    if (!other || other.count < entry.count) {
      problems.push(`missing from export: ${describe(entry.shape)}`)
    }
  }
  for (const [key, entry] of e) {
    const other = m.get(key)
    if (!other || other.count < entry.count) {
      problems.push(`extra in export: ${describe(entry.shape)}`)
    }
  }

  return {
    check: 'model_vs_export',
    problems,
    count: problems.length,
    model_items: total(m),
    export_items: total(e),
    positional: true,
    step_mm: step,
  }
}