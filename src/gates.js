/**
 * Gate definitions and the monitor's verdict logic.
 *
 * The monitor re-runs every check itself and records its own evidence. It returns
 * PASS / HOLD / REFUSED, and `not_run` never produces a PASS.
 * @module dsh-pcb/src/gates
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from './core.js'
import { GATE_ARTIFACTS, MVP_GATES } from './config.js'
import * as checks from './checks.js'
import * as trace from './trace.js'

/** Gate table: required artifacts, required checks, and who signs. */
export const GATES = {
  G0: { name: 'scope frozen', artifacts: GATE_ARTIFACTS.G0, checks: ['C0_approval'], signer: 'human-approver' },
  G1: { name: 'architecture and parts', artifacts: GATE_ARTIFACTS.G1, checks: ['C3_power_budget', 'C4_derating', 'C5_parts_resolved'], signer: 'monitor-verifier' },
  G2: { name: 'targets, tools, plan', artifacts: GATE_ARTIFACTS.G2, checks: ['C8_criteria_coverage', 'C9_tool_coverage'], signer: 'monitor-verifier' },
  G3: { name: 'risk and gap closure', artifacts: GATE_ARTIFACTS.G3, checks: ['C10_risk_mitigated', 'C1_traceability_plan'], signer: 'monitor-verifier' },
  G4: { name: 'fabrication readiness (MVP set)', artifacts: GATE_ARTIFACTS.G4, checks: MVP_GATES.G4, signer: 'monitor-verifier' },
}

export const GATE_ORDER = ['G0', 'G1', 'G2', 'G3', 'G4']

/** Resolve the artifact paths the monitor needs. Nothing is hidden in module state. */
export class Context {
  constructor(run, boardDir, options = {}) {
    this.run = run
    this.boardDir = boardDir
    this.kicadPath = options.kicadPath
    this.p = {
      REQ: join(boardDir, 'REQ.json'),
      TARGETS: join(boardDir, 'TARGETS.json'),
      POWER: join(boardDir, 'POWER.json'),
      DERATE: join(boardDir, 'DERATE.json'),
      BOM: join(boardDir, 'BOM.json'),
      RISK: join(boardDir, 'RISK.json'),
      TOOLS: join(boardDir, 'TOOLS.json'),
      RESULTS: join(boardDir, 'RESULTS.json'),
      PCB: join(boardDir, 'hw', 'board.json'),
      PCB_EXPORT: join(boardDir, 'hw', 'board.kicad_pcb'),
      NETLIST: join(boardDir, 'hw', 'netlist.json'),
      FOOTPRINT_RECORD: join(boardDir, 'hw', 'FOOTPRINTS.json'),
      RULESET: join(boardDir, 'hw', 'board.kicad_dru'),
      RULESET_BASELINE: join(run.baselineDir, 'board.kicad_dru'),
      DRC_REPORT: join(run.reportsDir, 'DRC.rpt'),
    }
  }
}

const notRun = (check, detail, tool = 'dsh-pcb') => ({
  check, status: 'not_run', strength: 'medium', detail, data: {}, command: null, tool, tool_version: null, exit_code: null,
})

/** Build one evidence payload bound to current artifact hashes. */
function evidencePayload(ctx, gate, res, artifacts) {
  const inputs = {}
  for (const id of artifacts) {
    try {
      inputs[id] = ctx.run.store.fileHash(id)
    } catch {
      inputs[id] = null
    }
  }
  return {
    gate,
    check: res.check,
    status: res.status,
    strength: res.strength,
    detail: res.detail,
    data: res.data,
    command: res.command,
    tool: res.tool,
    tool_version: res.tool_version,
    exit_code: res.exit_code,
    inputs,
    release_id: ctx.run.store.liveRelease(),
    scope: `${ctx.run.store.load().board ?? 'board'}@${ctx.run.store.liveRelease().slice(0, 12)}`,
    producer: 'artifact-owners',
    verifier: 'monitor-verifier',
  }
}

/** Execute the checks for one gate. */
export function runGateChecks(ctx, gate) {
  const spec = GATES[gate]
  const out = []
  const p = ctx.p
  for (const id of spec.checks) {
    switch (id) {
      case 'C0_approval':
        out.push([checks.c0Approval(ctx.run, 'REQ'), ['REQ']]); break
      case 'C3_power_budget':
        out.push([checks.c3PowerBudget(p.POWER), ['POWER']]); break
      case 'C4_derating':
        out.push([checks.c4Derating(p.DERATE), ['DERATE']]); break
      case 'C5_parts_resolved':
        out.push([checks.c5PartsResolved(p.BOM), ['BOM']]); break
      case 'C8_criteria_coverage':
        out.push([checks.c8CriteriaCoverage(p.REQ, p.TARGETS), ['REQ', 'TARGETS']]); break
      case 'C9_tool_coverage':
        out.push([checks.c9ToolCoverage(p.TOOLS), ['TOOLS']]); break
      case 'C10_risk_mitigated':
        out.push([checks.c10RiskMitigated(p.RISK), ['RISK']]); break
      case 'C1_traceability_plan':
        out.push([trace.evaluate(p.REQ, p.TARGETS, p.RESULTS, 'plan'), ['REQ', 'TARGETS']]); break
      case 'B2_kicad_drc':
        if (!existsSync(p.PCB_EXPORT)) out.push([notRun('B2_kicad_drc', 'no .kicad_pcb export to check', 'kicad-cli'), []])
        else out.push([checks.b2KicadDrc(p.PCB_EXPORT, p.DRC_REPORT, { kicadPath: ctx.kicadPath }), ['PCB']])
        break
      case 'B2g_geometry':
        out.push([checks.b2gGeometry(p.PCB), ['PCB']]); break
      case 'B3g_netlist_parity':
        out.push([checks.b3gNetlistParity(p.NETLIST, p.PCB), ['NETLIST', 'PCB']]); break
      case 'B3x_export_parity':
        if (!existsSync(p.PCB_EXPORT)) out.push([notRun('B3x_export_parity', 'no .kicad_pcb export'), []])
        else out.push([checks.b3xExportParity(p.PCB, p.PCB_EXPORT), ['PCB']])
        break
      case 'C7_footprint_record':
        out.push([checks.c7FootprintRecord(p.FOOTPRINT_RECORD, p.PCB), ['PCB']]); break
      default:
        throw new Error(`unknown check ${id}`)
    }
  }
  if (gate === 'G4') out.push([checks.b4RulesetGuard(p.RULESET, p.RULESET_BASELINE), ['PCB']])
  return out
}

/** Run, record and decide one gate. */
export function verifyGate(ctx, gate) {
  const spec = GATES[gate]
  const missing = ctx.run.store.missing(spec.artifacts)
  const results = runGateChecks(ctx, gate)
  const records = ctx.run.ledger.appendMany(results.map(([res, arts]) => ['evidence', evidencePayload(ctx, gate, res, arts)]))
  const recorded = results.map(([res], index) => ({
    check: res.check,
    status: res.status,
    strength: res.strength,
    detail: res.detail,
    evidence_id: records[index].hash.slice(0, 12),
  }))

  let verdict
  let reason
  if (missing.length) {
    verdict = 'HOLD'
    reason = `missing artifacts: ${missing.join(', ')}`
  } else if (recorded.some(r => r.status === 'refused')) {
    verdict = 'REFUSED'
    reason = `a check refused to run: ${recorded.filter(r => r.status === 'refused').map(r => r.detail).join('; ')}`
  } else if (recorded.some(r => r.status === 'fail')) {
    verdict = 'HOLD'
    reason = `failed checks: ${recorded.filter(r => r.status === 'fail').map(r => r.detail).join('; ')}`
  } else if (recorded.some(r => r.status === 'not_run')) {
    verdict = 'HOLD'
    reason = `not_run (never counted as pass): ${recorded.filter(r => r.status === 'not_run').map(r => r.detail).join('; ')}`
  } else {
    verdict = 'PASS'
    reason = 'all required checks passed with fresh evidence'
  }

  const record = {
    gate,
    name: spec.name,
    verdict,
    reason,
    checks: recorded,
    missing_artifacts: missing,
    release_id: ctx.run.store.liveRelease(),
    gate_digest: ctx.run.store.digest(spec.artifacts),
    signer: spec.signer,
    verifier: 'monitor-verifier',
    timestamp: nowIso(),
  }
  ctx.run.ledger.append('gate', record)
  return record
}

/** Walk gates in order; the first gate that does not PASS stops the walk. */
export function verifyAll(ctx, until = 'G4') {
  const verdicts = []
  for (const gate of GATE_ORDER.slice(0, GATE_ORDER.indexOf(until) + 1)) {
    const record = verifyGate(ctx, gate)
    verdicts.push(record)
    if (record.verdict !== 'PASS') break
  }
  return verdicts
}

/** Write the monitor verdict as markdown next to the run. */
export function writeMonitorReport(run, verdicts, board) {
  const path = join(run.reportsDir, 'MONITOR.md')
  mkdirSync(run.reportsDir, { recursive: true })
  const lines = [
    '# Monitor verdict',
    '',
    `- board: **${board}**`,
    `- release_id: \`${run.store.liveRelease()}\``,
    `- generated: ${nowIso()}`,
    `- chain: \`${JSON.stringify(run.ledger.verifyChain())}\``,
    '',
    'A `not_run` check is never a pass. PASS requires every required check to be pass.',
    '',
    '| gate | name | verdict | reason |',
    '|---|---|---|---|',
  ]
  for (const v of verdicts) lines.push(`| ${v.gate} | ${v.name} | **${v.verdict}** | ${v.reason.replaceAll('|', '/').slice(0, 180)} |`)
  lines.push('', '## Check detail', '')
  for (const v of verdicts) {
    lines.push(`### ${v.gate} - ${v.verdict}`, '', '| check | status | strength | detail |', '|---|---|---|---|')
    for (const c of v.checks) lines.push(`| ${c.check} | ${c.status} | ${c.strength ?? '-'} | ${c.detail.replaceAll('|', '/').slice(0, 150)} |`)
    lines.push('')
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}