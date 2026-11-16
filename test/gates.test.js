import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Run } from '../src/core.js'
import { Context, GATES, verifyGate } from '../src/gates.js'
import * as checks from '../src/checks.js'
import { mkTemp } from './helpers.js'

test('missing artifacts hold a gate', () => {
  const { dir, cleanup } = mkTemp('missing')
  try {
    const run = new Run(join(dir, 'run'))
    run.init('test')
    const record = verifyGate(new Context(run, join(dir, 'board')), 'G0')
    assert.equal(record.verdict, 'HOLD')
    assert.match(record.reason, /missing artifacts/)
    assert.deepEqual(record.missing_artifacts, ['REQ', 'NONGOALS', 'ENVELOPE', 'ASSUMPTIONS'])
  } finally { cleanup() }
})

test('producer separation refuses self-signed evidence', () => {
  assert.equal(checks.aProducerSeparation({ producer: 'a', verifier: 'a' }).status, 'refused')
  assert.equal(checks.aProducerSeparation({ producer: 'a', verifier: 'b' }).status, 'pass')
})

test('approval becomes void when the artifact changes', () => {
  const { dir, cleanup } = mkTemp('approval')
  try {
    const run = new Run(join(dir, 'run'))
    run.init('test')
    const req = join(dir, 'REQ.json')
    writeFileSync(req, '{"requirements":[]}', 'utf8')
    run.store.register('REQ', req, 'S0', 'requirements-analyst')
    run.ledger.append('approval', { artifact: 'REQ', sha256: run.store.fileHash('REQ'), approver: 'op' })
    assert.equal(checks.c0Approval(run, 'REQ').status, 'pass')
    writeFileSync(req, '{"requirements":[{"id":"REQ-99"}]}', 'utf8')
    const res = checks.c0Approval(run, 'REQ')
    assert.equal(res.status, 'fail')
    assert.match(res.detail, /payload changed/)
  } finally { cleanup() }
})

test('a relaxed ruleset is refused', () => {
  const { dir, cleanup } = mkTemp('ruleset')
  try {
    const dru = join(dir, 'board.kicad_dru')
    const baseline = join(dir, 'baseline.dru')
    writeFileSync(dru, '(clearance 0.2mm)', 'utf8')
    writeFileSync(baseline, '(clearance 0.2mm)', 'utf8')
    assert.equal(checks.b4RulesetGuard(dru, baseline).status, 'pass')
    writeFileSync(dru, '(clearance 0.05mm)', 'utf8')
    const res = checks.b4RulesetGuard(dru, baseline)
    assert.equal(res.status, 'refused')
    assert.match(res.detail, /modified the rules/)
  } finally { cleanup() }
})

test('semantic checks fail on bad data', () => {
  const { dir, cleanup } = mkTemp('semantic')
  try {
    const power = join(dir, 'POWER.json')
    writeFileSync(power, JSON.stringify({ rails: [{ name: '3V3', supply_current_ma_max: 100, margin_pct: 30, loads: [{ current_ma_worst: 90 }] }] }), 'utf8')
    assert.equal(checks.c3PowerBudget(power).status, 'fail')

    const derate = join(dir, 'DERATE.json')
    writeFileSync(derate, JSON.stringify({ items: [{ ref: 'C1', type: 'capacitor', rated: 6.3, applied: 5.5 }] }), 'utf8')
    assert.equal(checks.c4Derating(derate).status, 'fail')

    const bom = join(dir, 'BOM.json')
    writeFileSync(bom, JSON.stringify({ lines: [{ ref: 'U1', status: 'UNRESOLVED' }] }), 'utf8')
    assert.equal(checks.c5PartsResolved(bom).status, 'fail')

    const risk = join(dir, 'RISK.json')
    writeFileSync(risk, JSON.stringify({ risks: [{ id: 'R-1', rpn: 64, mitigation: '', residual_rpn: 64 }] }), 'utf8')
    assert.equal(checks.c10RiskMitigated(risk).status, 'fail')

    const tools = join(dir, 'TOOLS.json')
    writeFileSync(tools, JSON.stringify({ tools: [{ id: 'B2_kicad_drc', strength: 'weak' }], gate_checks: { G4: ['B2_kicad_drc'] } }), 'utf8')
    assert.equal(checks.c9ToolCoverage(tools).status, 'fail')
  } finally { cleanup() }
})

test('the G4 gate set names the kicad DRC and the geometry engine', () => {
  assert.ok(GATES.G4.checks.includes('B2_kicad_drc'))
  assert.ok(GATES.G4.checks.includes('B2g_geometry'))
  assert.equal(GATES.G4.signer, 'monitor-verifier')
  assert.deepEqual(GATES.G4.artifacts, ['PCB', 'NETLIST', 'FOOTPRINT_RECORD'])
})