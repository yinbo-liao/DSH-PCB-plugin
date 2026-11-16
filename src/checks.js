/**
 * Check library.
 *
 *   A*  evidence integrity  - hashes, freshness, producer/verifier separation
 *   B*  mechanical checks   - kicad-cli when present, and the deterministic geometry engine
 *   C*  semantic checks     - deterministic scripts over the JSON artifacts
 *
 * Every function returns the same normalised shape so the monitor can record it uniformly.
 * @module dsh-pcb/src/checks
 */
import { existsSync, readFileSync } from 'node:fs'
import { sha256File } from './core.js'
import * as geom from './geom.js'
import * as parity from './parity.js'
import * as kicad from './kicad.js'

export const PASS = 'pass'
export const FAIL = 'fail'
export const NOT_RUN = 'not_run'
export const REFUSED = 'refused'

const result = (check, status, { strength = 'medium', detail = '', data = {}, command = null, tool = 'dsh-pcb', tool_version = null, exit_code = null } = {}) => ({
  check, status, strength, detail, data, command, tool, tool_version, exit_code,
})

const load = path => JSON.parse(readFileSync(path, 'utf8'))

// --------------------------------------------------------------------------- Class A
/** True when the file on disk still matches the hash the evidence cites. */
export function aFreshness(run, artifactId, evidencedSha) {
  if (run.store.isFresh(artifactId, evidencedSha)) {
    return result('A1_freshness', PASS, {
      strength: 'strong',
      detail: `${artifactId} hash matches the evidence record`,
      data: { artifact: artifactId, sha256: evidencedSha },
    })
  }
  let current = null
  try {
    current = run.store.fileHash(artifactId)
  } catch {
    current = null
  }
  return result('A1_freshness', FAIL, {
    strength: 'strong',
    detail: `STALE_EVIDENCE: ${artifactId} changed since the evidence was recorded`,
    data: { artifact: artifactId, evidenced: evidencedSha, current },
  })
}

/** Producer and verifier must be different identities. */
export function aProducerSeparation(record) {
  if (record.producer === record.verifier) {
    return result('A3_producer_separation', REFUSED, {
      strength: 'strong',
      detail: 'producer and verifier are the same identity - self-signed evidence',
    })
  }
  return result('A3_producer_separation', PASS, {
    strength: 'strong',
    detail: `produced by ${record.producer}, verified by ${record.verifier}`,
  })
}

// --------------------------------------------------------------------------- Class B
/** kicad-cli PCB DRC. Absent tool means `not_run`, never `pass`. */
export function b2KicadDrc(pcbPath, reportPath, options = {}) {
  const res = kicad.runDrc(pcbPath, reportPath, options)
  if (res.status === NOT_RUN) {
    return result('B2_kicad_drc', NOT_RUN, {
      strength: 'strong',
      tool: 'kicad-cli',
      detail: `kicad-cli unavailable: ${res.reason ?? 'not found'}`,
      data: { blocker: 'install KiCad, or pass kicadPath, to enable PCB DRC' },
    })
  }
  return result('B2_kicad_drc', res.exit_code === 0 ? PASS : FAIL, {
    strength: 'strong',
    tool: 'kicad-cli',
    tool_version: res.version,
    command: res.command,
    exit_code: res.exit_code,
    detail: res.exit_code === 0 ? 'DRC exit code 0' : `DRC exit code ${res.exit_code}`,
    data: { report: res.report, stdout_tail: (res.stdout ?? '').slice(-800) },
  })
}

/** Deterministic subset DRC over the board model. */
export function b2gGeometry(boardPath) {
  const board = geom.loadBoard(boardPath)
  const out = geom.runAll(board)
  const total = out.total_violations
  let detail = `${total} violation(s) across clearance/width/annular/edge/unconnected`
  if (total) {
    const first = []
    for (const [name, r] of Object.entries(out.checks)) {
      for (const v of r.violations.slice(0, 3)) first.push(`${name}: ${JSON.stringify(v)}`)
    }
    detail += ` | ${first.slice(0, 5).join('; ')}`
  }
  return result('B2g_geometry', total === 0 ? PASS : FAIL, { strength: 'medium', detail, data: out })
}

/** Netlist <-> board model connectivity. */
export function b3gNetlistParity(netlistPath, boardPath) {
  const netlist = parity.loadNetlist(netlistPath)
  const board = geom.loadBoard(boardPath)
  const res = parity.netlistVsBoard(netlist, board)
  return result('B3g_netlist_parity', res.count === 0 ? PASS : FAIL, {
    strength: 'medium',
    detail: res.problems.length
      ? `${res.problems[0]} (${res.nets} nets, ${res.pads} pads)`
      : `netlist and board agree (${res.nets} nets, ${res.pads} pads)`,
    data: res,
  })
}

/** Board model <-> `.kicad_pcb` export. */
export function b3xExportParity(boardPath, pcbPath) {
  const model = geom.loadBoard(boardPath)
  const exportBoard = geom.loadKicadPcb(pcbPath)
  const res = parity.modelVsExport(model, exportBoard)
  return result('B3x_export_parity', res.count === 0 ? PASS : FAIL, {
    strength: 'medium',
    detail: res.problems.length
      ? `${res.problems[0]} (${res.model_items} modelled items, ${res.export_items} exported)`
      : `export matches model (${res.model_items} items)`,
    data: res,
  })
}

/** The producer must not relax the DRC ruleset to force a pass. */
export function b4RulesetGuard(druPath, baselinePath) {
  if (!existsSync(druPath)) {
    return result('B4_ruleset', NOT_RUN, { strength: 'strong', detail: 'no .kicad_dru present' })
  }
  if (!existsSync(baselinePath)) {
    return result('B4_ruleset', FAIL, {
      strength: 'strong',
      detail: 'no baseline ruleset recorded - cannot prove the rules were not relaxed',
    })
  }
  const current = sha256File(druPath)
  const baseline = sha256File(baselinePath)
  if (current !== baseline) {
    return result('B4_ruleset', REFUSED, {
      strength: 'strong',
      detail: 'DRC ruleset differs from the recorded baseline - producer modified the rules',
      data: { current, baseline },
    })
  }
  return result('B4_ruleset', PASS, { strength: 'strong', detail: 'ruleset matches baseline', data: { sha256: current } })
}

/** Footprint verification record must cover every footprint used by the board. */
export function c7FootprintRecord(recordPath, boardPath) {
  if (!existsSync(recordPath)) {
    return result('C7_footprint_record', FAIL, {
      strength: 'medium',
      detail: 'no FOOTPRINTS.json - no footprint-vs-part verification was recorded',
    })
  }
  const record = load(recordPath)
  const board = load(boardPath)
  const used = [...new Set((board.placements ?? []).map(p => p.footprint))]
  const verified = new Set((record.footprints ?? []).filter(f => f.verified_by).map(f => f.name))
  const missing = used.filter(name => !verified.has(name)).sort()
  if (missing.length) {
    return result('C7_footprint_record', FAIL, {
      strength: 'medium',
      detail: `footprints without a verification record: ${missing.join(', ')}`,
      data: { missing },
    })
  }
  return result('C7_footprint_record', PASS, {
    strength: 'medium',
    detail: `all ${used.length} footprints verified against a source`,
    data: { footprints: used.sort() },
  })
}

// --------------------------------------------------------------------------- Class C
/** Human approval bound to the artifact hash; editing the payload voids it. */
export function c0Approval(run, artifactId) {
  const records = run.ledger.read().filter(r => r.kind === 'approval' && r.artifact === artifactId)
  if (records.length === 0) {
    return result('C0_approval', FAIL, { strength: 'strong', detail: `no human approval recorded for ${artifactId}` })
  }
  let current
  try {
    current = run.store.fileHash(artifactId)
  } catch {
    return result('C0_approval', FAIL, { strength: 'strong', detail: `${artifactId} is not registered` })
  }
  const last = records.at(-1)
  if (last.sha256 !== current) {
    return result('C0_approval', FAIL, {
      strength: 'strong',
      detail: `approval binds ${(last.sha256 ?? '').slice(0, 12)}, artifact is now ${current.slice(0, 12)} - approval is void, the payload changed`,
    })
  }
  return result('C0_approval', PASS, {
    strength: 'strong',
    detail: `approved by ${last.approver} at ${last.timestamp}`,
    data: { sha256: current },
  })
}

/** Power budget closes with margin. */
export function c3PowerBudget(powerPath) {
  const data = load(powerPath)
  const problems = []
  for (const rail of data.rails ?? []) {
    const total = Number((rail.loads ?? []).reduce((sum, l) => sum + (l.current_ma_worst ?? 0), 0).toFixed(2))
    const margin = (rail.margin_pct ?? 30) / 100
    const limit = rail.supply_current_ma_max ?? 0
    const allowed = limit * (1 - margin)
    if (total > allowed) {
      problems.push(`${rail.name}: ${total} mA worst case > ${allowed.toFixed(0)} mA (supply ${limit} mA with ${rail.margin_pct ?? 30}% margin)`)
    }
    for (const loadItem of rail.loads ?? []) {
      if ((loadItem.current_ma_worst ?? 0) < 0) problems.push(`${rail.name}/${loadItem.name}: negative current`)
    }
  }
  return result('C3_power_budget', problems.length ? FAIL : PASS, {
    strength: 'medium',
    detail: problems[0] ?? `${(data.rails ?? []).length} rail(s) within margin`,
    data: { problems },
  })
}

/** Component derating within the design limits. */
export function c4Derating(deratePath) {
  const data = load(deratePath)
  const limits = { resistor: 60, capacitor: 80, semiconductor: 80, connector: 80 }
  const problems = []
  for (const item of data.items ?? []) {
    const pct = item.rated ? (100 * item.applied) / item.rated : 999
    const cap = limits[item.type] ?? 80
    if (pct > cap + 1e-9) problems.push(`${item.ref}: ${item.type} at ${pct.toFixed(1)}% of rating (limit ${cap}%)`)
  }
  return result('C4_derating', problems.length ? FAIL : PASS, {
    strength: 'medium',
    detail: problems[0] ?? `${(data.items ?? []).length} items within derating`,
    data: { problems },
  })
}

/** Every BOM line resolved, with lifecycle and datasheet recorded. */
export function c5PartsResolved(bomPath) {
  const data = load(bomPath)
  const problems = []
  for (const line of data.lines ?? []) {
    if (line.status === 'UNRESOLVED') {
      problems.push(`${line.ref}: UNRESOLVED - no verified MPN`)
      continue
    }
    for (const field of ['mpn', 'package', 'datasheet', 'lifecycle']) {
      if (!line[field]) problems.push(`${line.ref}: missing ${field}`)
    }
    if (['NRND', 'EOL', 'OBSOLETE'].includes(line.lifecycle) && !line.waiver) {
      problems.push(`${line.ref}: lifecycle ${line.lifecycle} without a waiver`)
    }
  }
  return result('C5_parts_resolved', problems.length ? FAIL : PASS, {
    strength: 'medium',
    detail: problems[0] ?? `${(data.lines ?? []).length} BOM lines resolved`,
    data: { problems },
  })
}

/** Every must-have requirement has a criterion with a numeric threshold. */
export function c8CriteriaCoverage(reqPath, targetsPath) {
  const reqs = load(reqPath).requirements ?? []
  const crits = load(targetsPath).criteria ?? []
  const must = reqs.filter(r => r.priority === 'must')
  const covered = new Set(crits.filter(c => c.threshold !== undefined && c.threshold !== null).map(c => c.req))
  const missing = must.filter(r => !covered.has(r.id)).map(r => r.id)
  const noThreshold = crits.filter(c => c.threshold === undefined || c.threshold === null).map(c => c.id)
  const problems = []
  if (missing.length) problems.push(`must-have requirements without a criterion: ${missing.join(', ')}`)
  if (noThreshold.length) problems.push(`criteria without a numeric threshold: ${noThreshold.join(', ')}`)
  return result('C8_criteria_coverage', problems.length ? FAIL : PASS, {
    strength: 'strong',
    detail: problems[0] ?? `${must.length} must-haves, all with criteria`,
    data: { must: must.length, criteria: crits.length },
  })
}

/** Every gate check maps to a tool strong enough to close a gate. */
export function c9ToolCoverage(toolsPath) {
  const data = load(toolsPath)
  const strength = new Map((data.tools ?? []).map(t => [t.id, t.strength ?? 'weak']))
  const problems = []
  for (const [gate, ids] of Object.entries(data.gate_checks ?? {})) {
    for (const id of ids) {
      if (!strength.has(id)) problems.push(`${gate}/${id}: no tool assigned`)
      else if (['weak', 'llm'].includes(strength.get(id))) problems.push(`${gate}/${id}: only a weak/LLM check - cannot close a gate`)
    }
  }
  return result('C9_tool_coverage', problems.length ? FAIL : PASS, {
    strength: 'strong',
    detail: problems[0] ?? 'every gate check maps to a deterministic tool',
    data: { problem_count: problems.length },
  })
}

/** Risks at or above RPN 60 need a mitigation and a reduced residual. */
export function c10RiskMitigated(riskPath) {
  const data = load(riskPath)
  const problems = []
  for (const risk of data.risks ?? []) {
    const rpn = risk.rpn ?? 0
    if (rpn >= 60) {
      if (!risk.mitigation) problems.push(`${risk.id}: RPN ${rpn} with no mitigation`)
      const residual = risk.residual_rpn ?? rpn
      if (residual >= 60) problems.push(`${risk.id}: residual RPN ${residual} still >= 60`)
    }
  }
  return result('C10_risk_mitigated', problems.length ? FAIL : PASS, {
    strength: 'medium',
    detail: problems[0] ?? `${(data.risks ?? []).length} risks within threshold`,
    data: { problems },
  })
}
/**
 * Trial results are complete and carry measurement provenance.
 *
 * A verdict without an instrument is an opinion. A criterion with no row is untested.
 */
export function c11ResultsComplete(resultsPath, targetsPath) {
  if (!existsSync(resultsPath)) {
    return result('C11_results_complete', FAIL, { strength: 'strong', detail: 'no RESULTS.json - the trial test was not executed' })
  }
  const results = load(resultsPath).results ?? []
  const criteria = load(targetsPath).criteria ?? []
  const byCriterion = new Map(results.map(r => [r.criterion, r]))
  const problems = []

  for (const criterion of criteria) {
    const row = byCriterion.get(criterion.id)
    if (!row) problems.push(`${criterion.id}: no measurement row`)
  }
  for (const row of results) {
    if (['pass', 'marginal', 'fail'].includes(row.verdict)) {
      if (row.value === null || row.value === undefined) problems.push(`${row.criterion}: verdict ${row.verdict} without a value`)
      if (!row.instrument) problems.push(`${row.criterion}: verdict ${row.verdict} without an instrument`)
    }
    // A recorded reason does not make an unexecuted test acceptable: the gate must hold.
    if (row.verdict === 'not_run') {
      problems.push(`${row.criterion}: not executed${row.reason ? ` (${row.reason})` : ''}`)
    }
  }
  const counts = {}
  for (const row of results) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
  return result('C11_results_complete', problems.length ? FAIL : PASS, {
    strength: 'strong',
    detail: problems[0] ?? `${criteria.length} criteria measured, ${JSON.stringify(counts)}`,
    data: { problems, counts },
  })
}