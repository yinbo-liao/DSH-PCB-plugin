/**
 * The model-facing tool surface of the PCB harness.
 *
 * Nine tools over the run directory: initialise a run, register artifacts, bind a human
 * approval, open and close typed packets, verify gates, run the geometry DRC, read
 * traceability, and check the run's own integrity.
 *
 * `registerTools` takes `defineTool` as an argument so the surface is testable without a
 * running Host. `index.js` passes the real one from `@deepseek-ai/dsh-tools`.
 *
 * @module dsh-pcb/src/plugin
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Run, nowIso, sha256File } from './core.js'
import { Router, RouterError } from './router.js'
import * as checks from './checks.js'
import * as gates from './gates.js'
import * as geom from './geom.js'
import * as trace from './trace.js'
import * as trial from './trial.js'
import { writePcbExport } from './boardgen.js'
import { detectKicad } from './kicad.js'
import { MVP_GATES, ROLE_SCOPES, STAGES } from './config.js'

const TEXT = text => [{ type: 'text', text }]

const str = description => ({ type: 'string', required: true, description })
const optStr = description => ({ type: 'string', description })
const ids = description => ({ type: 'array', items: { type: 'string' }, description })

const jsonOut = render => ({ schema: { type: 'json' }, render: (_args, value) => render(value) })

/** Resolve a path against the project base, so callers may pass relative paths. */
const resolvePath = (base, path) => (isAbsolute(path) ? path : resolve(base, path))

/**
 * Record the DRC ruleset baseline for a run. Overwriting is refused unless forced: replacing
 * a baseline is exactly how a relaxed ruleset would be laundered into a pass.
 */
export function recordBaseline(run, boardDir, { force = false } = {}) {
  const source = join(boardDir, 'hw', 'board.kicad_dru')
  if (!existsSync(source)) return { recorded: false, reason: `no ruleset at ${source}` }
  mkdirSync(run.baselineDir, { recursive: true })
  const target = join(run.baselineDir, 'board.kicad_dru')
  if (existsSync(target) && !force) {
    return { recorded: false, reason: 'baseline already recorded; pass force to replace it', sha256: sha256File(target) }
  }
  copyFileSync(source, target)
  return { recorded: true, sha256: sha256File(target), path: target }
}

/** Build the run object and its board directory from tool arguments and plugin config. */
function resolveRun(args, config) {
  const runDir = args.runDir ?? config.runDir
  if (!runDir) throw new Error('runDir is required (pass it, or set it in the plugin config)')
  const base = args.base ?? config.base ?? dirname(resolve(runDir))
  const boardDir = args.boardDir ?? config.boardDir ?? base
  return { run: new Run(resolve(runDir), resolve(base)), runDir: resolve(runDir), base: resolve(base), boardDir: resolvePath(resolve(base), boardDir) }
}

/**
 * Register every PCB harness tool on the Host tool service.
 * @param {object} ctx - Cordis context providing `tools`.
 * @param {{defineTool: Function, config?: object}} options
 * @returns {Function} disposer that unregisters the tools.
 */
export function registerTools(ctx, { defineTool, config = {} }) {
  const tools = []

  // 1 - create the run directory, index and ledger -----------------------------
  tools.push({
    name: 'pcb_init',
    description: 'Initialise a PCB harness run: create the artifact index and the evidence ledger for a board, and return its release id.',
    parameters: {
      runDir: str('Run directory to create, for example "runs/ldo3v3".'),
      board: str('Board identifier recorded in the run, for example "LDO3V3".'),
      boardDir: optStr('Board artifact directory. When given, its hw/board.kicad_dru is recorded as the DRC ruleset baseline.'),
      base: optStr('Project root used to store portable artifact paths. Defaults to the parent of runDir.'),
    },
    output: jsonOut(v => TEXT(`run initialised for ${v.board}\nrelease_id: ${v.release_id}\nbaseline: ${v.baseline ?? 'not recorded (pass boardDir to record it)'}`)),
    execute: async args => {
      const { run, boardDir } = resolveRun(args, config)
      const index = run.init(args.board)
      const baseline = args.boardDir ? recordBaseline(run, boardDir) : null
      return {
        board: args.board, runDir: run.root, release_id: index.release_id, artifacts: 0,
        baseline: baseline?.recorded ? baseline.sha256 : baseline?.reason ?? null,
      }
    },
  })

  // 2 - record the DRC ruleset baseline ---------------------------------------
  tools.push({
    name: 'pcb_baseline',
    description: 'Record the DRC ruleset (hw/board.kicad_dru) as the baseline for this run, so the G4 guard can detect a ruleset relaxed after the fact. Refuses to overwrite an existing baseline unless force is set.',
    parameters: {
      runDir: str('Existing run directory.'),
      boardDir: str('Board artifact directory containing hw/board.kicad_dru.'),
      force: { type: 'boolean', description: 'Replace an existing baseline. This defeats the guard; use only with a reason.' },
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(v.recorded ? `baseline recorded: ${v.sha256}` : `baseline not recorded: ${v.reason}`)),
    execute: async args => {
      const { run, boardDir } = resolveRun(args, config)
      return recordBaseline(run, boardDir, { force: args.force === true })
    },
  })

  // 2 - register an artifact ---------------------------------------------------
  tools.push({
    name: 'pcb_register',
    description: 'Register an artifact file in the run: hashes it, records the stage and the producing role, and returns the new release id. Evidence recorded earlier becomes stale when the file changes.',
    parameters: {
      runDir: str('Existing run directory.'),
      id: str('Artifact id, for example "REQ", "PCB" or "NETLIST".'),
      path: str('Path to the artifact file, absolute or relative to base.'),
      stage: str('Stage that produced it, S0 to S9.'),
      producer: str('Role that produced it, for example "layout-engineer".'),
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(`${v.id} registered\nsha256: ${v.sha256}\nrelease_id: ${v.release_id}`)),
    execute: async args => {
      const { run, base } = resolveRun(args, config)
      if (!STAGES.includes(args.stage)) throw new Error(`unknown stage ${args.stage}`)
      if (!ROLE_SCOPES[args.producer]) throw new Error(`unknown producer role ${args.producer}`)
      const record = run.store.register(args.id, resolvePath(base, args.path), args.stage, args.producer)
      run.ledger.append('artifact', { artifact: args.id, sha256: record.sha256, stage: args.stage, producer: args.producer })
      return { id: args.id, sha256: record.sha256, release_id: run.store.liveRelease(), stage: args.stage, producer: args.producer }
    },
  })

  // 3 - bind a human approval --------------------------------------------------
  tools.push({
    name: 'pcb_approve',
    description: 'Record a human approval bound to the current hash of an artifact. If the artifact changes afterwards the approval is void and the gate fails.',
    parameters: {
      runDir: str('Existing run directory.'),
      artifact: str('Artifact id being approved, usually "REQ".'),
      approver: str('Who approved it. Use a real human identity in production.'),
      scope: optStr('What the approval covers.'),
      note: optStr('Free-text note.'),
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(`approval recorded for ${v.artifact}\nsha256: ${v.sha256}\napprover: ${v.approver}`)),
    execute: async args => {
      const { run } = resolveRun(args, config)
      const sha256 = run.store.fileHash(args.artifact)
      run.ledger.append('approval', {
        artifact: args.artifact, sha256, approver: args.approver,
        role: 'human-approver', scope: args.scope ?? 'release', note: args.note ?? '',
      })
      return { artifact: args.artifact, sha256, approver: args.approver }
    },
  })

  // 4 - open a packet ----------------------------------------------------------
  tools.push({
    name: 'pcb_packet_open',
    description: 'Open a typed work packet for one role at one stage. Enforces stage order (the previous gate must PASS and not be stale), per-stage budgets, the role tool scope, and input hashes.',
    parameters: {
      runDir: str('Existing run directory.'),
      stage: str('Stage, S0 to S9.'),
      role: str('Role taking the work, for example "architect".'),
      objective: str('One sentence, externally testable.'),
      inputs: { type: 'object', additionalProperties: true, description: 'Map of artifact id to expected sha256. A mismatch rejects the packet.' },
      exitCriteria: ids('Externally checkable conditions that close the packet.'),
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(`packet ${v.packet_id} open\nstage ${v.stage} - ${v.role}\nobjective: ${v.objective}\nallowed tools: ${v.allowed_tools.join(', ') || '(none)'}`)),
    execute: async args => {
      const { run } = resolveRun(args, config)
      const router = new Router(run)
      return router.openPacket({
        stage: args.stage,
        role: args.role,
        objective: args.objective,
        inputs: args.inputs ?? {},
        exitCriteria: args.exitCriteria ?? [],
      })
    },
  })

  // 5 - close a packet ---------------------------------------------------------
  tools.push({
    name: 'pcb_packet_close',
    description: 'Close a packet. Outputs must be registered artifacts produced by the packet role and inside that role\'s writable scope, otherwise the close is rejected.',
    parameters: {
      runDir: str('Existing run directory.'),
      packetId: str('Packet id returned by pcb_packet_open.'),
      status: { type: 'string', enum: ['done', 'blocked', 'escalated'], description: 'How the packet ended. Defaults to done.' },
      outputs: ids('Artifact ids produced by this packet.'),
      note: optStr('Why it ended this way.'),
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(`packet ${v.packet_id} closed as ${v.status}\noutputs: ${(v.outputs ?? []).join(', ') || '(none)'}`)),
    execute: async args => {
      const { run } = resolveRun(args, config)
      return new Router(run).closePacket(args.packetId, {
        status: args.status ?? 'done', outputs: args.outputs ?? [], note: args.note ?? '',
      })
    },
  })

  // 6 - verify gates -----------------------------------------------------------
  tools.push({
    name: 'pcb_verify',
    description: 'Run the independent monitor over the gates: re-executes every check, records evidence bound to current hashes, and returns PASS, HOLD or REFUSED per gate. not_run never becomes a pass.',
    parameters: {
      runDir: str('Existing run directory.'),
      boardDir: str('Directory holding the board artifacts (REQ.json and friends, plus hw/).'),
      until: { type: 'string', enum: ['G0', 'G1', 'G2', 'G3', 'G4'], description: 'Last gate to evaluate. Defaults to G4.' },
      kicadPath: optStr('Explicit path to kicad-cli when it is not on PATH.'),
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(v.summary)),
    execute: async args => {
      const { run, boardDir } = resolveRun(args, config)
      const ctx = new gates.Context(run, boardDir, { kicadPath: args.kicadPath })
      const verdicts = gates.verifyAll(ctx, args.until ?? 'G4')
      const router = new Router(run)
      for (const verdict of verdicts) router.setGate(verdict.gate, verdict.verdict, verdict.gate_digest)
      const board = run.store.load().board ?? 'board'
      const reportPath = gates.writeMonitorReport(run, verdicts, board)
      const summary = [
        `verdicts for ${board} (release ${run.store.liveRelease()}):`,
        ...verdicts.map(v => `${v.gate} ${v.name}: ${v.verdict} - ${v.reason}`),
        `report: ${reportPath}`,
      ].join('\n')
      return {
        board,
        release_id: run.store.liveRelease(),
        verdicts: verdicts.map(v => ({ gate: v.gate, name: v.name, verdict: v.verdict, reason: v.reason, checks: v.checks })),
        report: reportPath,
        summary,
      }
    },
  })

  // 7 - geometry DRC ----------------------------------------------------------
  tools.push({
    name: 'pcb_geometry_drc',
    description: 'Run the deterministic subset DRC over a board model: copper clearance, minimum track width, via annular ring, board-edge clearance and floating pads. Reports coordinates, not a verdict about the whole board.',
    parameters: { boardPath: str('Path to board.json (the authoritative board model).') },
    output: jsonOut(v => TEXT(v.summary)),
    execute: async args => {
      const path = resolve(args.boardPath)
      if (!existsSync(path)) throw new Error(`board model not found: ${path}`)
      const board = geom.loadBoard(path)
      const out = geom.runAll(board)
      const summary = out.total_violations === 0
        ? `${path}: 0 violations across ${Object.keys(out.checks).length} checks (clearance ${board.rules.clearance ?? 0.2}mm)`
        : `${path}: ${out.total_violations} violation(s)\n${Object.entries(out.checks)
          .filter(([, r]) => r.count > 0)
          .map(([name, r]) => `${name}: ${JSON.stringify(r.violations.slice(0, 5))}`)
          .join('\n')}`
      return { board: path, total_violations: out.total_violations, checks: out.checks, summary }
    },
  })

  // 8 - traceability ----------------------------------------------------------
  tools.push({
    name: 'pcb_trace',
    description: 'Compute the requirement traceability matrix and match score from artifacts: which must-have requirements are covered, partial, unverified, missing or contradicted, and what blocks the phase.',
    parameters: {
      runDir: str('Existing run directory.'),
      boardDir: str('Directory holding REQ.json and TARGETS.json.'),
      phase: { type: 'string', enum: ['plan', 'release'], description: 'plan requires planned tests; release requires match_score >= 0.90. Defaults to plan.' },
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(v.summary)),
    execute: async args => {
      const { boardDir } = resolveRun(args, config)
      const result = trace.evaluate(join(boardDir, 'REQ.json'), join(boardDir, 'TARGETS.json'), join(boardDir, 'RESULTS.json'), args.phase ?? 'plan')
      const summary = `${result.status.toUpperCase()}: ${result.detail}\nrows: ${result.data.matrix.rows
        .map(r => `${r.req}=${r.status}`).join(' ')}`
      return { status: result.status, detail: result.detail, score: result.data.score, matrix: result.data.matrix, blockers: result.data.blockers, summary }
    },
  })

  // 9 - trial test: measurements in, verdicts out -----------------------------
  tools.push({
    name: 'pcb_trial_test',
    description: 'Execute the S7 trial test: convert bench measurements (CSV) into per-criterion verdicts by mechanical comparison, write RESULTS.json, and report coverage. A criterion with no measurement becomes not_run, never pass.',
    parameters: {
      runDir: str('Existing run directory.'),
      boardDir: str('Board artifact directory containing TARGETS.json.'),
      measurementsPath: optStr('CSV of bench measurements (criterion, board, value, unit, instrument, uncertainty, note). Omit to read an existing RESULTS.json.'),
      write: { type: 'boolean', description: 'Write RESULTS.json into boardDir. Defaults to true when measurementsPath is given.' },
      base: optStr('Project root for portable paths.'),
    },
    output: jsonOut(v => TEXT(v.summary)),
    execute: async args => {
      const { run, boardDir } = resolveRun(args, config)
      const targetsPath = join(boardDir, 'TARGETS.json')
      const resultsPath = join(boardDir, 'RESULTS.json')
      let results
      if (args.measurementsPath) {
        results = trial.buildResults(targetsPath, resolvePath(resolve(args.base ?? config.base ?? boardDir), args.measurementsPath))
        if (args.write !== false) writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
      } else {
        if (!existsSync(resultsPath)) throw new Error(`no measurements given and no RESULTS.json at ${resultsPath}`)
        results = JSON.parse(readFileSync(resultsPath, 'utf8'))
      }
      const counts = trial.summary(results)
      const missing = trial.missingMeasurements(results)
      const tracePhase = trace.evaluate(join(boardDir, 'REQ.json'), targetsPath, resultsPath, 'release')
      const summary = [
        `trial test: ${results.results.length} criteria, ${JSON.stringify(counts)}`,
        missing.length ? `unmeasured: ${missing.map(m => m.criterion).join(', ')}` : 'every criterion has a measurement',
        `release traceability: ${tracePhase.status} - ${tracePhase.detail}`,
      ].join('\n')
      let resultsSha = null
      try { resultsSha = run.store.fileHash('RESULTS') } catch { resultsSha = null }
      run.ledger.append('evidence', {
        gate: 'G5',
        check: 'S7_trial_test',
        status: counts.fail ? 'fail' : counts.not_run ? 'not_run' : 'pass',
        detail: summary.split('\n')[0],
        data: { counts, unmeasured: missing.map(m => m.criterion) },
        inputs: { RESULTS: resultsSha },
        producer: 'test-engineer',
        verifier: 'monitor-verifier',
      })
      return { counts, missing, results: results.results, trace: { status: tracePhase.status, detail: tracePhase.detail, score: tracePhase.data.score }, summary }
    },
  })

  // 10 - generate the KiCad export from the authoritative model ----------------
  tools.push({
    name: 'pcb_export',
    description: 'Generate the .kicad_pcb export from the authoritative board model, carrying placement rotation and footprint-relative text offsets. The export is what the fab builds; run pcb_verify afterwards to compare it with the model positionally.',
    parameters: {
      boardPath: str('Path to board.json (the authoritative board model).'),
      outPath: optStr('Output .kicad_pcb path. Defaults to board.kicad_pcb next to the model.'),
    },
    output: jsonOut(v => TEXT(`exported ${v.path}\n${v.items} copper items, ${v.bytes} bytes`)),
    execute: async args => {
      const boardPath = resolve(args.boardPath)
      if (!existsSync(boardPath)) throw new Error(`board model not found: ${boardPath}`)
      const { path, bytes, board } = writePcbExport(boardPath, args.outPath ? resolve(args.outPath) : undefined)
      const items = (board.routes ?? []).reduce((n, r) => n + Math.max(0, r.points.length - 1), 0)
        + (board.placements ?? []).length * 2 + (board.vias ?? []).length
      return { path, bytes, items, summary: `exported ${path} (${bytes} bytes)` }
    },
  })

  // 11 - run integrity --------------------------------------------------------
  tools.push({
    name: 'pcb_doctor',
    description: 'Check the run itself: ledger hash chain, artifact hash drift, toolkit availability (kicad-cli) and what the gate set can and cannot prove.',
    parameters: { runDir: str('Existing run directory.'), kicadPath: optStr('Explicit path to kicad-cli.'), base: optStr('Project root for portable paths.') },
    output: jsonOut(v => TEXT(v.summary)),
    execute: async args => {
      const { run } = resolveRun(args, config)
      const chain = run.ledger.verifyChain()
      const index = run.store.load()
      const drift = []
      for (const [id, record] of Object.entries(index.artifacts)) {
        try {
          if (run.store.fileHash(id) !== record.sha256) drift.push(id)
        } catch {
          drift.push(`${id} (missing file)`)
        }
      }
      const kicad = detectKicad({ kicadPath: args.kicadPath ?? config.kicadPath })
      const summary = [
        `board: ${index.board}`,
        `kicad-cli: ${kicad.available ? `found ${kicad.version}` : `MISSING - DRC will be not_run (${kicad.reason})`}`,
        `ledger chain: ${chain.ok ? `ok, ${chain.records} records` : `BROKEN at ${chain.at}: ${chain.reason}`}`,
        `artifacts: ${Object.keys(index.artifacts).length}, release ${run.store.liveRelease()}`,
        `hash drift: ${drift.length ? drift.join(', ') : 'none'}`,
        `G4 checks: ${MVP_GATES.G4.join(', ')}`,
      ].join('\n')
      return {
        board: index.board,
        kicad,
        chain,
        artifacts: Object.keys(index.artifacts).length,
        release_id: run.store.liveRelease(),
        drift,
        summary,
      }
    },
  })

  const disposers = tools.map(tool => ctx.tools.register(defineTool({ ...tool, timeoutMs: 120000 })))
  return () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}

/** Registered tool names, for tests and documentation. */
export const TOOL_NAMES = [
  'pcb_init', 'pcb_baseline', 'pcb_register', 'pcb_approve', 'pcb_packet_open', 'pcb_packet_close',
  'pcb_verify', 'pcb_export', 'pcb_geometry_drc', 'pcb_trace', 'pcb_trial_test', 'pcb_doctor',
]