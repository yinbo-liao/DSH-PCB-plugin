/**
 * Trial test (S7): turn bench measurements into per-criterion verdicts, mechanically.
 *
 * The rule that makes this honest: a verdict is derived by comparison, never by judgement.
 *  - no measurement              -> not_run (never pass)
 *  - outside the threshold        -> fail
 *  - inside the threshold but within the marginal band -> marginal
 *  - otherwise                    -> pass
 * The worst verdict across boards wins, so one bad board cannot be averaged away.
 *
 * @module dsh-pcb/src/trial
 */
import { existsSync, readFileSync } from 'node:fs'

/** Parse a measurements CSV with a header row. Empty cells become ''. */
export function parseCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  const clean = rows.filter(r => r.some(cell => cell.trim() !== ''))
  if (clean.length === 0) return []
  const header = clean[0].map(h => h.trim())
  return clean.slice(1).map(cells => Object.fromEntries(header.map((key, i) => [key, (cells[i] ?? '').trim()])))
}

const rank = { fail: 3, marginal: 2, pass: 1, not_run: 0 }

/** Marginal band width: 10% of the tolerance, or 10% of a single-sided limit. */
export function marginalBand(threshold) {
  const { min, max } = threshold
  if (min !== undefined && max !== undefined) return Math.abs(max - min) * 0.1
  if (max !== undefined) return Math.abs(max) * 0.1
  if (min !== undefined) return Math.abs(min) * 0.1
  return 0
}

/** Derive one verdict by comparison. `reason` always explains the number. */
export function deriveVerdict(criterion, measurement) {
  const threshold = criterion.threshold ?? {}
  const band = marginalBand(threshold)
  if (!measurement || measurement.value === '' || measurement.value === undefined) {
    return { verdict: 'not_run', reason: 'no measurement recorded', value: null }
  }
  const value = Number(measurement.value)
  if (!Number.isFinite(value)) {
    return { verdict: 'not_run', reason: `unparseable value ${JSON.stringify(measurement.value)}`, value: null }
  }
  const unit = threshold.unit ?? ''
  if (threshold.max !== undefined && value > threshold.max) {
    const marginal = value - threshold.max <= band
    return {
      verdict: marginal ? 'marginal' : 'fail',
      reason: `${value}${unit} > ${threshold.max}${unit}${marginal ? ` (within the ${band}${unit} marginal band)` : ''}`,
      value,
    }
  }
  if (threshold.min !== undefined && value < threshold.min) {
    const marginal = threshold.min - value <= band
    return {
      verdict: marginal ? 'marginal' : 'fail',
      reason: `${value}${unit} < ${threshold.min}${unit}${marginal ? ` (within the ${band}${unit} marginal band)` : ''}`,
      value,
    }
  }
  const nearMax = threshold.max !== undefined && threshold.max - value <= band
  const nearMin = threshold.min !== undefined && value - threshold.min <= band
  if (nearMax || nearMin) {
    return { verdict: 'marginal', reason: `${value}${unit} is inside the limit but within the ${band}${unit} marginal band`, value }
  }
  const range = threshold.min !== undefined && threshold.max !== undefined
    ? ` (${threshold.min}-${threshold.max}${unit})`
    : ''
  return { verdict: 'pass', reason: `${value}${unit} within limits${range}`, value }
}

/**
 * Build RESULTS.json from a measurements CSV and the criteria file.
 * Every criterion gets a row; criteria with no measurement become `not_run`.
 */
export function buildResults(targetsPath, measurementsCsvPath) {
  const criteria = JSON.parse(readFileSync(targetsPath, 'utf8')).criteria ?? []
  const measurements = measurementsCsvPath && existsSync(measurementsCsvPath)
    ? parseCsv(readFileSync(measurementsCsvPath, 'utf8'))
    : []

  const byCriterion = new Map()
  for (const row of measurements) {
    if (!row.criterion) continue
    if (!byCriterion.has(row.criterion)) byCriterion.set(row.criterion, [])
    byCriterion.get(row.criterion).push(row)
  }

  const results = []
  for (const criterion of criteria) {
    const rows = byCriterion.get(criterion.id) ?? []
    if (rows.length === 0) {
      results.push({
        criterion: criterion.id,
        req: criterion.req,
        verdict: 'not_run',
        reason: 'no measurement recorded for this criterion',
        value: null,
        unit: criterion.threshold?.unit ?? '',
        boards: [],
        instrument: '',
        uncertainty: '',
        note: '',
      })
      continue
    }
    let worst = null
    const boards = []
    for (const row of rows) {
      const derived = deriveVerdict(criterion, row)
      boards.push({ board: row.board ?? 'B?', verdict: derived.verdict, value: derived.value })
      if (worst === null || rank[derived.verdict] > rank[worst.verdict]
        || (rank[derived.verdict] === rank[worst.verdict] && derived.value > worst.value)) {
        worst = derived
      }
    }
    results.push({
      criterion: criterion.id,
      req: criterion.req,
      verdict: worst.verdict,
      reason: worst.reason,
      value: worst.value,
      unit: criterion.threshold?.unit ?? '',
      boards,
      instrument: rows.map(r => r.instrument).filter(Boolean).join(' | '),
      uncertainty: rows.map(r => r.uncertainty).filter(Boolean).join(' | '),
      note: rows.map(r => r.note).filter(Boolean).join(' | '),
    })
  }
  return {
    schema: 'pcbh/results/1',
    generated: new Date().toISOString(),
    criteria: criteria.length,
    results,
  }
}

/** Criteria that carry a must-have requirement but have no measurement row. */
export function missingMeasurements(results) {
  return results.results.filter(r => r.verdict === 'not_run').map(r => ({ criterion: r.criterion, req: r.req, reason: r.reason }))
}

/** Counts by verdict, for a one-line summary. */
export function summary(results) {
  const counts = { pass: 0, marginal: 0, fail: 0, not_run: 0 }
  for (const row of results.results) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
  return counts
}