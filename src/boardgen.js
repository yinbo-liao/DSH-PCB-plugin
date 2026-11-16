/**
 * Board model -> `.kicad_pcb` export.
 *
 * The model (`board.json`) is authoritative; this file is derived so KiCad can open the board
 * and run its own DRC. Two rules learned the hard way (see `examples/ldo3v3/hw/DRC-TRIAGE.md`):
 *
 *  1. the placement rotation must be carried into the footprint, or rotated parts land on the
 *     wrong pads - that produced a genuine 5V/GND short;
 *  2. property text positions are relative to the footprint, not absolute page coordinates, or
 *     every reference is offset by the placement.
 *
 * @module dsh-pcb/src/boardgen
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { FOOTPRINTS } from './geom.js'

/** Reference/value text offsets per footprint, relative to the body, chosen to clear pads. */
export const TEXT_OFFSETS = {
  TP_1PAD: [-4.0, -2.5],
  U_SOT223: [0.0, -5.0],
  TERM_1x02: [0.0, -4.0],
  D_SMA: [0.0, -3.5],
}

/** Footprints whose reference text goes on the Fab layer: silk space is tight around test pads. */
export const FAB_REFERENCE = new Set(['TP_1PAD'])

const num = value => {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : String(value)
}

/** Generate the `.kicad_pcb` text for a board model. */
export function generatePcb(board) {
  const [width, height] = board.size
  const netNames = [...new Set((board.nets ?? []).map(net => net.name))].sort()
  const netId = new Map(netNames.map((name, index) => [name, index + 1]))
  const padNet = new Map()
  for (const net of board.nets ?? []) {
    for (const [ref, pad] of net.pads) padNet.set(`${ref}.${pad}`, net.name)
  }

  const lines = [
    '(kicad_pcb (version 20240108) (generator "dsh-pcb-boardgen")',
    '  (general (thickness 1.6))',
    '  (paper "A4")',
    '  (layers',
    '    (0 "F.Cu" signal)',
    '    (31 "B.Cu" signal)',
    '    (36 "B.SilkS" user "B.Silkscreen")',
    '    (37 "F.SilkS" user "F.Silkscreen")',
    '    (44 "Edge.Cuts" user)',
    '  )',
    '  (setup (pad_to_mask_clearance 0))',
    '  (net 0 "")',
  ]
  for (const name of netNames) lines.push(`  (net ${netId.get(name)} "${name}")`)
  lines.push(`  (gr_rect (start 0 0) (end ${num(width)} ${num(height)}) `
    + '(stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))')

  for (const placement of board.placements ?? []) {
    const footprint = placement.footprint
    const pads = FOOTPRINTS[footprint]
    if (!pads) throw new Error(`unknown footprint: ${footprint}`)
    const [x, y] = placement.at
    const rot = placement.rot ?? 0
    const [refDx, refDy] = TEXT_OFFSETS[footprint] ?? [0, -3]
    const refLayer = FAB_REFERENCE.has(footprint) ? 'F.Fab' : 'F.SilkS'
    lines.push(`  (footprint "pcbh:${footprint}" (layer "F.Cu") (at ${num(x)} ${num(y)} ${num(rot)})`)
    lines.push(`    (property "Reference" "${placement.ref}" (at ${num(refDx)} ${num(refDy)} 0) (layer "${refLayer}"))`)
    lines.push(`    (property "Value" "${footprint}" (at ${num(-refDx)} ${num(-refDy)} 0) (layer "F.Fab"))`)
    for (const [dx, dy, w, h, prot, name, kind] of pads) {
      const net = padNet.get(`${placement.ref}.${name}`)
      const netStr = net ? ` (net ${netId.get(net)} "${net}")` : ' (net 0)'
      if (kind === 'THT') {
        lines.push(`    (pad "${name}" thru_hole rect (at ${num(dx)} ${num(dy)} ${num(prot)}) `
          + `(size ${num(w)} ${num(h)}) (drill 1.1) (layers "*.Cu" "*.Mask")${netStr})`)
      } else {
        lines.push(`    (pad "${name}" smd rect (at ${num(dx)} ${num(dy)} ${num(prot)}) `
          + `(size ${num(w)} ${num(h)}) (layers "F.Cu" "F.Paste" "F.Mask")${netStr})`)
      }
    }
    lines.push('  )')
  }

  for (const route of board.routes ?? []) {
    const points = route.points
    const id = netId.get(route.net) ?? 0
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x1, y1] = points[i]
      const [x2, y2] = points[i + 1]
      lines.push(`  (segment (start ${num(x1)} ${num(y1)}) (end ${num(x2)} ${num(y2)}) `
        + `(width ${num(route.width)}) (layer "${route.layer}") (net ${id}))`)
    }
  }

  for (const via of board.vias ?? []) {
    lines.push(`  (via (at ${num(via.x)} ${num(via.y)}) (size ${num(via.size)}) `
      + `(drill ${num(via.drill)}) (layers "F.Cu" "B.Cu") (net ${netId.get(via.net) ?? 0}))`)
  }

  lines.push(')')
  return `${lines.join('\n')}\n`
}

/** Load a board model, generate the export and write it. */
export function writePcbExport(boardPath, outPath) {
  const board = JSON.parse(readFileSync(boardPath, 'utf8'))
  const text = generatePcb(board)
  const target = outPath ?? boardPath.replace(/board\.json$/, 'board.kicad_pcb')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return { path: target, bytes: Buffer.byteLength(text, 'utf8'), board }
}