#!/usr/bin/env node
/**
 * Replay the bundled example through S0-G6 and write a transcript.
 *
 * It works on a copy inside the run directory, so the example fixtures are never modified.
 * On a machine with KiCad this closes G4 and records a real DRC verdict; without KiCad, G4 is
 * recorded as HOLD with the blocker named - the correct result, not a script failure.
 *
 * Usage: node scripts/record-run.mjs [--run <dir>] [--kicad <path>] [--json]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '../test/fake-sdk.js'
import { registerTools } from '../src/plugin.js'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = join(HERE, 'examples', 'ldo3v3')
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const ROOT = resolve(argOf('--run', join(HERE, 'runs', 'ldo3v3')))
const KICAD = argOf('--kicad', undefined)
const asJson = argv.includes('--json')
const RUN = join(ROOT, 'run')
const BOARD = join(ROOT, 'board')

const ARTIFACTS = [
  ['REQ', 'REQ.json', 'S0', 'requirements-analyst'],
  ['NONGOALS', 'NONGOALS.md', 'S0', 'requirements-analyst'],
  ['ENVELOPE', 'ENVELOPE.json', 'S0', 'requirements-analyst'],
  ['ASSUMPTIONS', 'ASSUMPTIONS.json', 'S0', 'requirements-analyst'],
  ['ARCH', 'ARCH.md', 'S1', 'architect'],
  ['IFACE', 'IFACE.json', 'S1', 'architect'],
  ['POWER', 'POWER.json', 'S1', 'architect'],
  ['BOM', 'BOM.json', 'S1', 'part-scout'],
  ['DERATE', 'DERATE.json', 'S1', 'part-scout'],
  ['TARGETS', 'TARGETS.json', 'S2', 'requirements-analyst'],
  ['TOOLS', 'TOOLS.json', 'S3', 'tool-scout'],
  ['PLAN', 'PLAN.json', 'S4', 'supervisor'],
  ['RISK', 'RISK.json', 'S5', 'supervisor'],
  ['GAP', 'GAP.json', 'S5', 'supervisor'],
  ['LOOPLOG', 'LOOPLOG.md', 'S5', 'supervisor'],
  ['DECISION', 'DECISION.md', 'S5', 'supervisor'],
  ['PCB', 'hw/board.json', 'S6', 'layout-engineer'],
  ['NETLIST', 'hw/netlist.json', 'S6', 'layout-engineer'],
  ['FOOTPRINT_RECORD', 'hw/FOOTPRINTS.json', 'S6', 'layout-engineer'],
  ['RULESET', 'hw/board.kicad_dru', 'S6', 'layout-engineer'],
  ['TESTPLAN', 'TESTPLAN.md', 'S7', 'test-engineer'],
]

const registered = new Map()
const ctx = { tools: { register: definition => { registered.set(definition.name, definition); return () => {} } } }
registerTools(ctx, { defineTool, config: {} })
const call = (name, args) => registered.get(name).execute(args)

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
cpSync(EXAMPLE, BOARD, { recursive: true })

await call('pcb_init', { runDir: RUN, board: 'LDO3V3', base: ROOT, boardDir: BOARD })
for (const [id, rel, stage, producer] of ARTIFACTS) {
  await call('pcb_register', { runDir: RUN, id, path: `board/${rel}`, stage, producer, base: ROOT })
}
await call('pcb_approve', { runDir: RUN, artifact: 'REQ', approver: 'operator', note: 'recorded run' })

const verify = await call('pcb_verify', { runDir: RUN, boardDir: BOARD, base: ROOT, until: 'G4', kicadPath: KICAD })
const trial = await call('pcb_trial_test', { runDir: RUN, boardDir: BOARD, measurementsPath: 'board/MEASUREMENTS.csv', base: ROOT })

const transcript = {
  run: RUN,
  generated: new Date().toISOString(),
  kicad: KICAD ?? 'looked up on PATH',
  gates: verify.verdicts.map(v => ({ gate: v.gate, verdict: v.verdict, reason: v.reason, checks: v.checks })),
  trial: { counts: trial.counts, unmeasured: trial.missing.map(m => m.criterion), trace: trial.trace },
}
writeFileSync(join(ROOT, 'TRANSCRIPT.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')

if (asJson) console.log(JSON.stringify(transcript, null, 2))
else {
  for (const gate of transcript.gates) console.log(`${gate.gate}  ${gate.verdict.padEnd(8)} ${gate.reason}`)
  console.log(`trial: ${JSON.stringify(trial.counts)}  unmeasured: ${transcript.trial.unmeasured.join(', ') || 'none'}`)
  console.log(`transcript: ${join(ROOT, 'TRANSCRIPT.json')}`)
}
process.exitCode = transcript.gates.every(g => g.verdict === 'PASS') ? 0 : 1