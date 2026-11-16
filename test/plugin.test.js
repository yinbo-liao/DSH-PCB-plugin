import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from './fake-sdk.js'
import { registerTools, TOOL_NAMES } from '../src/plugin.js'
import { Router, RouterError } from '../src/router.js'
import { Run } from '../src/core.js'
import { copyExample, fakeCtx, seedRun } from './helpers.js'

function mounted() {
  const { ctx, registered } = fakeCtx()
  const dispose = registerTools(ctx, { defineTool, config: {} })
  return { registered, dispose }
}

test('the plugin registers exactly the documented tool surface', () => {
  const { registered, dispose } = mounted()
  assert.deepEqual([...registered.keys()].sort(), [...TOOL_NAMES].sort())
  for (const definition of registered.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('pcb_geometry_drc reports zero violations on the example board', async () => {
  const { registered } = mounted()
  const { board, cleanup } = copyExample('drc')
  try {
    const result = await registered.get('pcb_geometry_drc').execute({ boardPath: join(board, 'hw', 'board.json') })
    assert.equal(result.total_violations, 0)
    assert.match(result.summary, /0 violations/)
  } finally { cleanup() }
})

test('full S0-G4 run on the example board: G0-G3 PASS, G4 holds without kicad-cli', async () => {
  const { registered } = mounted()
  const { project, board, cleanup } = copyExample('flow')
  const runDir = join(project, 'run')
  try {
    await registered.get('pcb_init').execute({ runDir, board: 'LDO3V3', base: project })
    await seedRun(registered, runDir, project)

    const result = await registered.get('pcb_verify').execute({ runDir, boardDir: board, base: project, until: 'G4' })
    const byGate = new Map(result.verdicts.map(v => [v.gate, v]))

    for (const gate of ['G0', 'G1', 'G2', 'G3']) {
      assert.equal(byGate.get(gate)?.verdict, 'PASS', `${gate}: ${byGate.get(gate)?.reason}`)
    }
    const g4 = byGate.get('G4')
    assert.ok(g4, 'G4 must be evaluated')
    assert.equal(g4.verdict, 'HOLD', 'without kicad-cli the gate must hold, never pass')
    assert.match(g4.reason, /not_run/)
    const byCheck = new Map(g4.checks.map(c => [c.check, c]))
    assert.equal(byCheck.get('B2g_geometry').status, 'pass')
    assert.equal(byCheck.get('B3g_netlist_parity').status, 'pass')
    assert.equal(byCheck.get('C7_footprint_record').status, 'pass')
    assert.equal(byCheck.get('B2_kicad_drc').status, 'not_run')
    assert.ok(byCheck.get('B4_ruleset'), 'the ruleset guard must run at G4')
    assert.equal(byCheck.get('B4_ruleset').status, 'pass')

    const report = await registered.get('pcb_verify').execute({ runDir, boardDir: board, base: project, until: 'G2' })
    assert.equal(report.verdicts.at(-1).verdict, 'PASS')
  } finally { cleanup() }
})

test('stage order is enforced: S1 cannot open before G0 passes', async () => {
  const { registered } = mounted()
  const { project, cleanup } = copyExample('order')
  const runDir = join(project, 'run')
  try {
    await registered.get('pcb_init').execute({ runDir, board: 'LDO3V3', base: project })
    await assert.rejects(
      registered.get('pcb_packet_open').execute({ runDir, stage: 'S1', role: 'architect', objective: 'design', base: project }),
      /G0/,
    )
  } finally { cleanup() }
})
test('an injected clearance violation holds G4 and names the nets', async () => {
  const { registered } = mounted()
  const { project, board, cleanup } = copyExample('inject')
  const runDir = join(project, 'run')
  try {
    await registered.get('pcb_init').execute({ runDir, board: 'LDO3V3', base: project })
    await seedRun(registered, runDir)

    const boardPath = join(board, 'hw', 'board.json')
    const data = JSON.parse((await import('node:fs')).readFileSync(boardPath, 'utf8'))
    for (const route of data.routes) {
      if (route.net === '5V' && route.width === 1) route.points[route.points.length - 1] = [30, 22]
    }
    writeFileSync(boardPath, JSON.stringify(data, null, 2), 'utf8')
    await registered.get('pcb_register').execute({ runDir, id: 'PCB', path: 'board/hw/board.json', stage: 'S6', producer: 'layout-engineer', base: project })

    const result = await registered.get('pcb_verify').execute({ runDir, boardDir: board, base: project, until: 'G4' })
    const g4 = result.verdicts.find(v => v.gate === 'G4')
    assert.equal(g4.verdict, 'HOLD')
    assert.match(g4.reason, /clearance/)
  } finally { cleanup() }
})

test('separating duties: a producer cannot call a reserved tool', async () => {
  const { project, cleanup } = copyExample('sod')
  const runDir = join(project, 'run')
  try {
    const run = new Run(runDir, project)
    run.init('sod')
    const router = new Router(run)
    const packet = router.openPacket({ stage: 'S0', role: 'requirements-analyst', objective: 'write requirements' })
    assert.ok(packet.denied_tools.includes('approve'))
    assert.throws(() => router.recordToolCall(packet.packet_id, 'approve', true), RouterError)
    const denied = run.ledger.read().filter(r => r.kind === 'tool_denied')
    assert.equal(denied.length, 1)
  } finally { cleanup() }
})

test('pcb_doctor reports the chain and the missing tool', async () => {
  const { registered } = mounted()
  const { project, cleanup } = copyExample('doctor')
  const runDir = join(project, 'run')
  try {
    await registered.get('pcb_init').execute({ runDir, board: 'LDO3V3', base: project })
    const result = await registered.get('pcb_doctor').execute({ runDir, base: project })
    assert.equal(result.chain.ok, true)
    assert.deepEqual(result.drift, [])
    assert.match(result.summary, /kicad-cli/)
  } finally { cleanup() }
})