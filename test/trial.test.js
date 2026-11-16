import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildResults, deriveVerdict, marginalBand, missingMeasurements, parseCsv, summary } from '../src/trial.js'
import { c11ResultsComplete } from '../src/checks.js'
import { Context, verifyGate } from '../src/gates.js'
import { Run } from '../src/core.js'
import { copyExample, mkTemp, REPO } from './helpers.js'

const CRITERION = { id: 'CRIT-02', req: 'REQ-02', threshold: { min: 3.135, max: 3.465, unit: 'V' } }
const FIXTURES = join(REPO, 'test', 'fixtures')

test('verdicts are derived by comparison, never by judgement', () => {
  assert.equal(deriveVerdict(CRITERION, { value: '3.30' }).verdict, 'pass')
  assert.equal(deriveVerdict(CRITERION, { value: '3.48' }).verdict, 'marginal')   // 0.015 > limit, inside band
  assert.equal(deriveVerdict(CRITERION, { value: '3.60' }).verdict, 'fail')
  assert.equal(deriveVerdict(CRITERION, { value: '' }).verdict, 'not_run')
  assert.equal(deriveVerdict(CRITERION, { value: 'abc' }).verdict, 'not_run')
  assert.equal(deriveVerdict(CRITERION, { value: '3.14' }).verdict, 'marginal')   // near the lower limit
})

test('a single-sided limit uses 10% of the limit as the band', () => {
  const maxOnly = { id: 'X', req: 'R', threshold: { max: 85, unit: 'C' } }
  assert.equal(marginalBand(maxOnly.threshold), 8.5)
  assert.equal(deriveVerdict(maxOnly, { value: '88' }).verdict, 'marginal')
  assert.equal(deriveVerdict(maxOnly, { value: '96' }).verdict, 'fail')
})

test('the worst verdict across boards wins', () => {
  const results = buildResults(
    join(REPO, 'examples', 'ldo3v3', 'TARGETS.json'),
    join(FIXTURES, 'synthetic-pass.csv'),
  )
  const crit = results.results.find(r => r.criterion === 'CRIT-02')
  assert.equal(crit.verdict, 'pass')
  assert.ok(crit.instrument.length > 0, 'a pass must carry its instrument')
})

test('an empty measurement file makes every criterion not_run', () => {
  const { board, cleanup } = copyExample('trial-empty')
  try {
    const results = buildResults(join(board, 'TARGETS.json'), join(board, 'MEASUREMENTS.csv'))
    const counts = summary(results)
    assert.equal(counts.pass, 0)
    assert.ok(counts.not_run >= 7)
    assert.equal(missingMeasurements(results).length, counts.not_run)
  } finally { cleanup() }
})

test('an over-limit measurement fails and a missing row is not_run', () => {
  const results = buildResults(
    join(REPO, 'examples', 'ldo3v3', 'TARGETS.json'),
    join(FIXTURES, 'synthetic-partial.csv'),
  )
  const thermal = results.results.find(r => r.criterion === 'CRIT-05')
  assert.equal(thermal.verdict, 'fail')
  assert.match(thermal.reason, />\s*85/)
  const size = results.results.find(r => r.criterion === 'CRIT-06')
  assert.equal(size.verdict, 'not_run')
})

test('the CSV parser handles quoted fields with commas', () => {
  const rows = parseCsv('criterion,instrument,value\nCRIT-01,"DMM 0.05%, 4-wire",0.02\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].instrument, 'DMM 0.05%, 4-wire')
  assert.equal(rows[0].value, '0.02')
})

test('C11 fails when a value has no instrument', () => {
  const { dir, cleanup } = mkTemp('c11')
  try {
    const targets = join(REPO, 'examples', 'ldo3v3', 'TARGETS.json')
    const results = buildResults(targets, join(FIXTURES, 'synthetic-pass.csv'))
    results.results.find(r => r.criterion === 'CRIT-01').instrument = ''
    const resultsPath = join(dir, 'RESULTS.json')
    writeFileSync(resultsPath, JSON.stringify(results), 'utf8')
    const res = c11ResultsComplete(resultsPath, targets)
    assert.equal(res.status, 'fail')
    assert.match(res.detail, /without an instrument/)
  } finally { cleanup() }
})

/** Seed a run with the example artifacts plus TESTPLAN, RESULTS and EVAL. */
function seededRun({ measurements }) {
  const { project, board, cleanup } = copyExample('g5')
  const runDir = join(project, 'run')
  const run = new Run(runDir, project)
  run.init('LDO3V3')
  const artifacts = [
    ['REQ', 'REQ.json', 'S0', 'requirements-analyst'],
    ['TARGETS', 'TARGETS.json', 'S2', 'requirements-analyst'],
    ['TESTPLAN', 'TESTPLAN.md', 'S7', 'test-engineer'],
  ]
  for (const [id, rel, stage, producer] of artifacts) run.store.register(id, join(board, rel), stage, producer)
  const results = buildResults(join(board, 'TARGETS.json'), measurements)
  writeFileSync(join(board, 'RESULTS.json'), JSON.stringify(results, null, 2), 'utf8')
  run.store.register('RESULTS', join(board, 'RESULTS.json'), 'S7', 'test-engineer')
  writeFileSync(join(board, 'EVAL.md'), '# Results evaluation\n\nCandidate verdict recorded.\n', 'utf8')
  run.store.register('EVAL', join(board, 'EVAL.md'), 'S8', 'supervisor')
  return { run, board, cleanup }
}

test('G5 passes on complete measurements and holds on an empty set', () => {
  const pass = seededRun({ measurements: join(FIXTURES, 'synthetic-pass.csv') })
  try {
    const record = verifyGate(new Context(pass.run, pass.board), 'G5')
    assert.equal(record.verdict, 'PASS', record.reason)
  } finally { pass.cleanup() }

  const empty = seededRun({ measurements: undefined })
  try {
    const record = verifyGate(new Context(empty.run, empty.board), 'G5')
    assert.equal(record.verdict, 'HOLD')
    assert.match(record.reason, /not executed/)
  } finally { empty.cleanup() }
})

test('G6 requires every requirement covered at release', () => {
  const pass = seededRun({ measurements: join(FIXTURES, 'synthetic-pass.csv') })
  try {
    const record = verifyGate(new Context(pass.run, pass.board), 'G6')
    assert.equal(record.verdict, 'PASS', record.reason)
  } finally { pass.cleanup() }

  const partial = seededRun({ measurements: join(FIXTURES, 'synthetic-partial.csv') })
  try {
    const record = verifyGate(new Context(partial.run, partial.board), 'G6')
    assert.equal(record.verdict, 'HOLD')
    assert.match(record.reason, /contradicted|fail/)
  } finally { partial.cleanup() }
})