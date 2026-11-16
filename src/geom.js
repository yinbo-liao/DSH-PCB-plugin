/**
 * Deterministic geometry checks on a board model, plus an s-expression reader for `.kicad_pcb`.
 *
 * This is a *subset* DRC and says so: it verifies copper clearance, minimum track width, via
 * annular ring, board-edge clearance and floating pads. It cannot see impedance, thermal, EMC
 * or assembly yield, and every gate that uses it records the check as `medium` strength.
 *
 * @module dsh-pcb/src/geom
 */
import { readFileSync } from 'node:fs'

/** Relative pad definitions per footprint: [dx, dy, w, h, rot, name, kind]. */
export const FOOTPRINTS = {
  TERM_1x02: [
    [-1.75, 0, 2, 2, 0, '1', 'THT'],
    [1.75, 0, 2, 2, 0, '2', 'THT'],
  ],
  R_1206: [
    [-1.4, 0, 1.2, 1.6, 0, '1', 'SMD'],
    [1.4, 0, 1.2, 1.6, 0, '2', 'SMD'],
  ],
  C_1206_V: [
    [0, -1.4, 1.2, 1.4, 0, '1', 'SMD'],
    [0, 1.4, 1.2, 1.4, 0, '2', 'SMD'],
  ],
  C_0603_V: [
    [0, -0.75, 0.8, 0.9, 0, '1', 'SMD'],
    [0, 0.75, 0.8, 0.9, 0, '2', 'SMD'],
  ],
  D_SMA: [
    [-1.9, 0, 1.8, 1.6, 0, '1', 'SMD'],
    [1.9, 0, 1.8, 1.6, 0, '2', 'SMD'],
  ],
  U_SOT223: [
    [-2.3, -2.2, 1.2, 2, 0, '1', 'SMD'],
    [0, -2.2, 1.2, 2, 0, '2', 'SMD'],
    [2.3, -2.2, 1.2, 2, 0, '3', 'SMD'],
    [0, 2.2, 3.4, 2, 0, '4', 'SMD'],
  ],
  TP_1PAD: [[0, 0, 1.2, 1.2, 0, '1', 'SMD']],
}

const rad = deg => (deg * Math.PI) / 180

/** Axis-aligned or rotated rectangle as four points. */
export function rectPoly(cx, cy, w, h, rot = 0) {
  const r = rad(rot)
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([dx, dy]) => [cx + dx * c - dy * s, cy + dx * s + dy * c])
}

/** A track segment with width, as a rectangle. */
export function segPoly(x1, y1, x2, y2, width) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len === 0) return rectPoly(x1, y1, width, width)
  const nx = (-dy / len) * (width / 2)
  const ny = (dx / len) * (width / 2)
  return [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]
}

/** A circle (via pad) approximated by a 16-gon. */
export function circlePoly(cx, cy, d, n = 16) {
  const r = d / 2
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

const axes = poly => poly.map((p, i) => {
  const q = poly[(i + 1) % poly.length]
  const ex = q[0] - p[0]
  const ey = q[1] - p[1]
  const len = Math.hypot(ex, ey)
  return len < 1e-12 ? null : [-ey / len, ex / len]
}).filter(Boolean)

const project = (poly, axis) => {
  let min = Infinity
  let max = -Infinity
  for (const p of poly) {
    const d = p[0] * axis[0] + p[1] * axis[1]
    if (d < min) min = d
    if (d > max) max = d
  }
  return [min, max]
}

/** Separating-axis intersection test for two convex polygons. */
export function polygonsIntersect(a, b, eps = 1e-9) {
  for (const axis of [...axes(a), ...axes(b)]) {
    const [amin, amax] = project(a, axis)
    const [bmin, bmax] = project(b, axis)
    if (amax < bmin + eps || bmax < amin + eps) return false
  }
  return true
}

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const den = dx * dx + dy * dy
  if (den === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / den))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function segSegDist(a1, a2, b1, b2) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const o1 = orient(a1, a2, b1)
  const o2 = orient(a1, a2, b2)
  const o3 = orient(b1, b2, a1)
  const o4 = orient(b1, b2, a2)
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0
  return Math.min(
    pointSegDist(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]),
    pointSegDist(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1]),
    pointSegDist(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]),
    pointSegDist(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]),
  )
}

/** Edge-to-edge distance between two convex polygons; 0 when they touch or overlap. */
export function polyDistance(a, b) {
  if (polygonsIntersect(a, b)) return 0
  let best = Infinity
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j += 1) {
      const d = segSegDist(a1, a2, b[j], b[(j + 1) % b.length])
      if (d < best) best = d
    }
  }
  return best
}

/** Bake a placement into absolute pad records. */
export function placePads(footprint, [cx, cy], rot, ref) {
  const pads = FOOTPRINTS[footprint]
  if (!pads) throw new Error(`unknown footprint: ${footprint}`)
  const r = rad(rot)
  const c = Math.cos(r)
  const s = Math.sin(r)
  return pads.map(([dx, dy, w, h, prot, name, kind]) => ({
    ref,
    pad: name,
    x: cx + dx * c - dy * s,
    y: cy + dx * s + dy * c,
    w,
    h,
    rot: rot + prot,
    kind,
  }))
}

const bbox = poly => {
  const xs = poly.map(p => p[0])
  const ys = poly.map(p => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Load the authoritative board model (`board.json`). */
export function loadBoard(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const [w, h] = data.size
  const rules = data.rules ?? {}
  const board = {
    name: data.board ?? 'board',
    size: [w, h],
    outline: [[0, 0], [w, 0], [w, h], [0, h]],
    rules,
    shapes: [],
    pads: [],
    tracks: [],
    vias: [],
  }
  const padNet = new Map()
  for (const net of data.nets ?? []) {
    for (const [ref, pad] of net.pads) padNet.set(`${ref}.${pad}`, net.name)
  }
  for (const placement of data.placements ?? []) {
    for (const pad of placePads(placement.footprint, placement.at, placement.rot ?? 0, placement.ref)) {
      pad.net = padNet.get(`${placement.ref}.${pad.pad}`) ?? ''
      board.pads.push(pad)
      if (pad.net) {
        board.shapes.push({
          kind: 'pad',
          net: pad.net,
          layers: pad.kind === 'THT' ? ['F.Cu', 'B.Cu'] : ['F.Cu'],
          poly: rectPoly(pad.x, pad.y, pad.w, pad.h, pad.rot),
          ref: `${placement.ref}.${pad.pad}`,
          detail: `${pad.w}x${pad.h}mm ${pad.kind}`,
        })
      }
    }
  }
  for (const route of data.routes ?? []) {
    const pts = route.points
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[i + 1]
      board.tracks.push({ ...route, x1, y1, x2, y2 })
      board.shapes.push({
        kind: 'track',
        net: route.net,
        layers: [route.layer],
        poly: segPoly(x1, y1, x2, y2, route.width),
        ref: `track(${x1.toFixed(1)},${y1.toFixed(1)})-(${x2.toFixed(1)},${y2.toFixed(1)})`,
        detail: `w=${route.width}mm`,
      })
    }
  }
  for (const via of data.vias ?? []) {
    board.vias.push(via)
    board.shapes.push({
      kind: 'via',
      net: via.net,
      layers: ['F.Cu', 'B.Cu'],
      poly: circlePoly(via.x, via.y, via.size),
      ref: `via(${via.x.toFixed(1)},${via.y.toFixed(1)})`,
      detail: `size=${via.size} drill=${via.drill}`,
    })
  }
  return board
}

// ------------------------------------------------------------------------- s-expressions
/** Minimal s-expression reader for `.kicad_pcb`: atoms, quoted strings, nested lists. */
export function parseSexpr(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i += 1
    } else if (ch === '(' || ch === ')') {
      tokens.push(ch)
      i += 1
    } else if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          buf += text[j + 1]
          j += 2
        } else {
          buf += text[j]
          j += 1
        }
      }
      tokens.push({ str: buf })
      i = j + 1
    } else {
      let j = i
      while (j < text.length && !/[\s()"]/.test(text[j])) j += 1
      tokens.push(text.slice(i, j))
      i = j
    }
  }
  const build = pos => {
    const out = []
    let p = pos + 1
    while (p < tokens.length) {
      const tok = tokens[p]
      if (tok === '(') {
        const [child, next] = build(p)
        out.push(child)
        p = next
      } else if (tok === ')') {
        return [out, p + 1]
      } else {
        out.push(typeof tok === 'object' ? tok.str : tok)
        p += 1
      }
    }
    return [out, p]
  }
  return build(0)[0]
}

const head = node => (Array.isArray(node) && typeof node[0] === 'string' ? node[0] : null)
const find = (node, name) => (Array.isArray(node) ? node.filter(child => head(child) === name) : [])
const first = (node, name) => find(node, name)[0]
const num = (node, index, fallback = 0) => (Number.isFinite(Number(node?.[index])) ? Number(node[index]) : fallback)

/** Extract the same shape set from a `.kicad_pcb` export, to cross-check the model. */
export function loadKicadPcb(path) {
  const root = parseSexpr(readFileSync(path, 'utf8'))
  const nets = new Map()
  for (const net of find(root, 'net')) if (net.length >= 3) nets.set(net[1], net[2])
  const board = { name: 'export', size: [null, null], outline: [], rules: {}, shapes: [], pads: [], tracks: [], vias: [] }
  for (const seg of find(root, 'segment')) {
    const start = first(seg, 'start')
    const end = first(seg, 'end')
    const width = num(first(seg, 'width'), 1)
    const layer = first(seg, 'layer')?.[1] ?? 'F.Cu'
    const netNum = first(seg, 'net')?.[1] ?? '0'
    board.shapes.push({
      kind: 'track',
      net: nets.get(netNum) ?? '',
      layers: [layer],
      poly: segPoly(num(start, 1), num(start, 2), num(end, 1), num(end, 2), width),
      detail: `w=${width}`,
    })
  }
  for (const via of find(root, 'via')) {
    const at = first(via, 'at')
    const size = num(first(via, 'size'), 1)
    const drill = num(first(via, 'drill'), 1)
    const netNum = first(via, 'net')?.[1] ?? '0'
    board.vias.push({ x: num(at, 1), y: num(at, 2), size, drill })
    board.shapes.push({
      kind: 'via',
      net: nets.get(netNum) ?? '',
      layers: ['F.Cu', 'B.Cu'],
      poly: circlePoly(num(at, 1), num(at, 2), size),
      detail: `size=${size} drill=${drill}`,
    })
  }
  for (const fp of find(root, 'footprint')) {
    const at = first(fp, 'at')
    const fx = num(at, 1)
    const fy = num(at, 2)
    let ref = ''
    for (const prop of find(fp, 'property')) if (prop[1] === 'Reference') ref = prop[2]
    for (const pad of find(fp, 'pad')) {
      const pat = first(pad, 'at')
      const size = first(pad, 'size')
      const netNum = first(pad, 'net')?.[1] ?? '0'
      const name = pad[1] ?? '1'
      const w = num(size, 1)
      const h = num(size, 2)
      board.shapes.push({
        kind: 'pad',
        net: nets.get(netNum) ?? '',
        layers: (first(pad, 'layers') ?? []).slice(1),
        poly: rectPoly(fx + num(pat, 1), fy + num(pat, 2), w, h, num(pat, 3)),
        ref: `${ref}.${name}`,
        detail: `${w}x${h}mm`,
      })
    }
  }
  return board
}

// ------------------------------------------------------------------------------- checks
/** Clearance between copper of different nets on a shared layer. */
export function checkClearance(board, limitOverride) {
  const limit = limitOverride ?? board.rules.clearance ?? 0.2
  const violations = []
  const shapes = board.shapes.filter(s => s.net)
  for (let i = 0; i < shapes.length; i += 1) {
    const a = shapes[i]
    const [ax1, ay1, ax2, ay2] = bbox(a.poly)
    for (let j = i + 1; j < shapes.length; j += 1) {
      const b = shapes[j]
      if (a.net === b.net) continue
      if (!a.layers.some(l => b.layers.includes(l))) continue
      const [bx1, by1, bx2, by2] = bbox(b.poly)
      if (ax1 - limit > bx2 || bx1 - limit > ax2 || ay1 - limit > by2 || by1 - limit > ay2) continue
      const d = polyDistance(a.poly, b.poly)
      if (d < limit - 1e-9) {
        violations.push({
          rule: 'clearance',
          limit_mm: limit,
          actual_mm: Number(d.toFixed(4)),
          a: `${a.kind}:${a.ref}(${a.net})`,
          b: `${b.kind}:${b.ref}(${b.net})`,
          layers: a.layers.filter(l => b.layers.includes(l)),
        })
      }
    }
  }
  return { check: 'clearance', limit_mm: limit, violations, count: violations.length }
}

/** Minimum track width. */
export function checkTrackWidth(board) {
  const limit = board.rules.min_track ?? 0.25
  const violations = board.tracks
    .filter(t => t.width < limit - 1e-9)
    .map(t => ({
      rule: 'min_track',
      limit_mm: limit,
      actual_mm: t.width,
      net: t.net,
      at: [t.x1, t.y1, t.x2, t.y2],
    }))
  return { check: 'track_width', limit_mm: limit, violations, count: violations.length }
}

/** Via annular ring. */
export function checkAnnularRing(board) {
  const limit = board.rules.min_annular ?? 0.15
  const violations = board.vias
    .map(v => ({ ring: (v.size - v.drill) / 2, v }))
    .filter(({ ring }) => ring < limit - 1e-9)
    .map(({ ring, v }) => ({
      rule: 'annular',
      limit_mm: limit,
      actual_mm: Number(ring.toFixed(4)),
      at: [v.x, v.y],
    }))
  return { check: 'annular_ring', limit_mm: limit, violations, count: violations.length }
}

/** Copper distance to the board edge. */
export function checkEdgeClearance(board) {
  const limit = board.rules.edge_clearance ?? 0.3
  const [w, h] = board.size
  const violations = []
  for (const shape of board.shapes) {
    if (!shape.net) continue
    let worst = Infinity
    for (const [x, y] of shape.poly) {
      const m = Math.min(x, y, w - x, h - y)
      if (m < worst) worst = m
    }
    if (worst < limit - 1e-9) {
      violations.push({
        rule: 'edge_clearance',
        limit_mm: limit,
        actual_mm: Number(worst.toFixed(4)),
        item: `${shape.kind}:${shape.ref}`,
      })
    }
  }
  return { check: 'edge_clearance', limit_mm: limit, violations, count: violations.length }
}

/** Every pad that carries a net must be touched by copper of that net. */
export function checkUnconnected(board) {
  const violations = []
  for (const pad of board.pads) {
    if (!pad.net) continue
    const probe = rectPoly(pad.x, pad.y, 0.01, 0.01)
    const hit = board.shapes.some(s => s.net === pad.net && s.kind !== 'pad'
      && polyDistance(probe, s.poly) <= 1e-6)
    if (!hit) violations.push({ rule: 'floating_pad', pad: `${pad.ref}.${pad.pad}`, net: pad.net })
  }
  return { check: 'unconnected_pads', violations, count: violations.length }
}

/** Run every geometry check; returns per-check results and a total. */
export function runAll(board) {
  const checks = {
    clearance: checkClearance(board),
    track_width: checkTrackWidth(board),
    annular_ring: checkAnnularRing(board),
    edge_clearance: checkEdgeClearance(board),
    unconnected: checkUnconnected(board),
  }
  return {
    checks,
    total_violations: Object.values(checks).reduce((sum, r) => sum + r.count, 0),
  }
}