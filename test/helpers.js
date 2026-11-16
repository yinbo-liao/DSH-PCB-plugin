/** Shared test helpers: workspace-local temp dirs and the example board fixture. */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const EXAMPLE = join(REPO, 'examples', 'ldo3v3')
const TMP_ROOT = join(REPO, 'test', '.tmp')

/** Create a workspace-local temp directory (the OS temp area is restricted in some sandboxes). */
export function mkTemp(name = 'run') {
  const dir = join(TMP_ROOT, `${name}-${Math.random().toString(16).slice(2, 10)}`)
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Copy the example board into a temp project and return its path. */
export function copyExample(label = 'board') {
  const { dir, cleanup } = mkTemp(label)
  const board = join(dir, 'board')
  cpSync(EXAMPLE, board, { recursive: true })
  return { project: dir, board, cleanup }
}

/** Every example artifact with the role that produces it. */
export const EXAMPLE_ARTIFACTS = [
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
]

/** Register every example artifact and record a human approval for REQ. */
export async function seedRun(tools, runDir, project, boardRel = 'board') {
  await tools.get('pcb_baseline').execute({ runDir, boardDir: `${project}/${boardRel}`, base: project })
  for (const [id, rel, stage, producer] of EXAMPLE_ARTIFACTS) {
    await tools.get('pcb_register').execute({ runDir, id, path: `${boardRel}/${rel}`, stage, producer, base: project })
  }
  await tools.get('pcb_approve').execute({ runDir, artifact: 'REQ', approver: 'test-operator' })
}

/** A fake ctx that records tool definitions instead of registering them. */
export function fakeCtx() {
  const registered = new Map()
  return {
    registered,
    ctx: { tools: { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } },
  }
}