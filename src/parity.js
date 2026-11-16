/**
 * Connectivity parity: netlist <-> board model, and board model <-> `.kicad_pcb` export.
 * The export check is what makes the model trustworthy: the fab builds the export.
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

const signature = (board, kinds) => {
  const map = new Map()
  for (const shape of board.shapes) {
    if (!kinds.includes(shape.kind) || !shape.net) continue
    const key = `${shape.kind}|${shape.net}|${shape.poly.length}`
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

/** The exported `.kicad_pcb` must contain the same copper as the model. */
export function modelVsExport(model, exportBoard, kinds = ['track', 'pad', 'via']) {
  const problems = []
  const m = signature(model, kinds)
  const e = signature(exportBoard, kinds)
  for (const [key, count] of m) {
    const other = e.get(key) ?? 0
    if (other < count) problems.push(`missing from export: ${key.replaceAll('|', ' ')} x${count - other}`)
  }
  for (const [key, count] of e) {
    const other = m.get(key) ?? 0
    if (other < count) problems.push(`extra in export: ${key.replaceAll('|', ' ')} x${count - other}`)
  }
  const total = map => [...map.values()].reduce((a, b) => a + b, 0)
  return {
    check: 'model_vs_export',
    problems,
    count: problems.length,
    model_items: total(m),
    export_items: total(e),
  }
}