/**
 * Requirement traceability and task-match score. Status is computed from artifacts, never
 * asserted: a requirement is `covered` only when fresh passing evidence exists.
 * @module dsh-pcb/src/trace
 */
import { existsSync, readFileSync } from 'node:fs'

const WEIGHTS = { safety: 3, core: 2, other: 1 }
const VALUES = { covered: 1, partial: 0.6, unverified: 0.2, missing: 0, contradicted: 0 }

const load = path => JSON.parse(readFileSync(path, 'utf8'))

/** Build the requirement -> criterion -> status matrix. */
export function buildMatrix(reqPath, targetsPath, resultsPath) {
  const reqs = load(reqPath).requirements ?? []
  const crits = load(targetsPath).criteria ?? []
  const results = new Map()
  if (resultsPath && existsSync(resultsPath)) {
    for (const row of load(resultsPath).results ?? []) results.set(row.criterion, row)
  }
  const byReq = new Map()
  for (const criterion of crits) {
    if (!byReq.has(criterion.req)) byReq.set(criterion.req, [])
    byReq.get(criterion.req).push(criterion)
  }

  const rows = []
  const problems = []
  for (const req of reqs) {
    if (req.priority !== 'must') continue
    const own = byReq.get(req.id) ?? []
    if (own.length === 0) {
      rows.push({ req: req.id, class: req.class ?? 'core', status: 'missing', element: req.design_element ?? '', note: 'no criterion' })
      problems.push(`${req.id}: no criterion`)
      continue
    }
    if (!req.design_element) {
      rows.push({ req: req.id, class: req.class ?? 'core', status: 'missing', element: '', note: 'no design element recorded' })
      problems.push(`${req.id}: no design element`)
      continue
    }
    const statuses = own.map(criterion => {
      const result = results.get(criterion.id)
      if (!result) return 'unverified'
      if (result.verdict === 'pass') return 'covered'
      if (result.verdict === 'marginal') return 'partial'
      return 'contradicted'
    })
    let status
    if (statuses.includes('contradicted')) status = 'contradicted'
    else if (statuses.every(s => s === 'covered')) status = 'covered'
    else if (statuses.some(s => s === 'covered' || s === 'partial')) status = 'partial'
    else status = 'unverified'

    const row = { req: req.id, class: req.class ?? 'core', status, element: req.design_element, criteria: own.map(c => c.id) }
    if (status === 'unverified') row.test_planned = own.every(c => c.test_planned === true)
    rows.push(row)
  }
  return { rows, problems }
}

/** Weighted score over must-have requirements. */
export function score(matrix) {
  let num = 0
  let den = 0
  const counts = {}
  for (const row of matrix.rows) {
    const w = WEIGHTS[row.class] ?? 1
    num += w * (VALUES[row.status] ?? 0)
    den += w
    counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return {
    match_score: den ? Number((num / den).toFixed(3)) : 0,
    counts,
    requirements: matrix.rows.length,
  }
}

/**
 * Evaluate traceability for a phase.
 * `plan` (G3) requires no missing/contradicted and a planned test per unverified item.
 * `release` (G6) additionally requires match_score >= 0.90 and nothing unverified.
 */
export function evaluate(reqPath, targetsPath, resultsPath, phase = 'plan') {
  const matrix = buildMatrix(reqPath, targetsPath, resultsPath)
  const summary = score(matrix)
  const blockers = []
  for (const row of matrix.rows) {
    if (row.status === 'missing' || row.status === 'contradicted') blockers.push(`${row.req}: ${row.status}`)
    if (row.status === 'unverified' && phase === 'plan' && !row.test_planned) blockers.push(`${row.req}: unverified and no planned test`)
  }
  if (phase === 'release') {
    if (summary.match_score < 0.9) blockers.push(`match_score ${summary.match_score} < 0.90`)
    for (const row of matrix.rows) if (row.status === 'unverified') blockers.push(`${row.req}: unverified at release`)
  }
  return {
    check: 'C1_traceability',
    status: blockers.length ? 'fail' : 'pass',
    strength: 'strong',
    detail: blockers.length
      ? blockers[0]
      : `match_score ${summary.match_score} over ${summary.requirements} must-haves, counts ${JSON.stringify(summary.counts)}`,
    data: { matrix, score: summary, phase, blockers },
    command: null,
    tool: 'dsh-pcb-trace',
    tool_version: null,
    exit_code: null,
  }
}