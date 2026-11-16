import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ledger, Run, Store, sha256 } from '../src/core.js'
import { mkTemp } from './helpers.js'

test('ledger appends are chained and verify', () => {
  const { dir, cleanup } = mkTemp('ledger')
  try {
    const ledger = new Ledger(dir)
    ledger.append('note', { i: 1 })
    ledger.append('note', { i: 2 })
    const verdict = ledger.verifyChain()
    assert.equal(verdict.ok, true)
    assert.equal(verdict.records, 2)
  } finally { cleanup() }
})

test('editing a ledger record breaks the chain', () => {
  const { dir, cleanup } = mkTemp('tamper')
  try {
    const ledger = new Ledger(dir)
    ledger.append('evidence', { status: 'fail', check: 'B2' })
    ledger.append('evidence', { status: 'pass', check: 'B2' })
    const lines = ledger.read()
    lines[0].status = 'pass'
    writeFileSync(ledger.path, `${lines.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const verdict = ledger.verifyChain()
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /does not match its hash/)
  } finally { cleanup() }
})

test('deleting a ledger record breaks the chain', () => {
  const { dir, cleanup } = mkTemp('delete')
  try {
    const ledger = new Ledger(dir)
    const records = ledger.appendMany([['note', { i: 1 }], ['note', { i: 2 }], ['note', { i: 3 }]])
    writeFileSync(ledger.path, `${[records[0], records[2]].map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    assert.equal(ledger.verifyChain().ok, false)
  } finally { cleanup() }
})

test('live release changes when an artifact is edited after registration', () => {
  const { dir, cleanup } = mkTemp('release')
  try {
    const run = new Run(join(dir, 'run'))
    run.init('test')
    const file = join(dir, 'a.json')
    writeFileSync(file, '{"v":1}', 'utf8')
    run.store.register('REQ', file, 'S0', 'requirements-analyst')
    const before = run.store.liveRelease()
    writeFileSync(file, '{"v":2}', 'utf8')
    const after = run.store.liveRelease()
    assert.notEqual(before, after)
    assert.equal(run.store.isFresh('REQ', run.store.get('REQ').sha256), false)
  } finally { cleanup() }
})

test('per-artifact gate digest only moves when that artifact moves', () => {
  const { dir, cleanup } = mkTemp('digest')
  try {
    const run = new Run(join(dir, 'run'))
    run.init('test')
    const req = join(dir, 'REQ.json')
    const pcb = join(dir, 'PCB.json')
    writeFileSync(req, '{"a":1}', 'utf8')
    writeFileSync(pcb, '{"b":1}', 'utf8')
    run.store.register('REQ', req, 'S0', 'requirements-analyst')
    run.store.register('PCB', pcb, 'S6', 'layout-engineer')
    const g0 = run.store.digest(['REQ', 'NONGOALS'])
    writeFileSync(pcb, '{"b":2}', 'utf8')
    assert.equal(run.store.digest(['REQ', 'NONGOALS']), g0)
    writeFileSync(req, '{"a":2}', 'utf8')
    assert.notEqual(run.store.digest(['REQ', 'NONGOALS']), g0)
  } finally { cleanup() }
})

test('store digest marks missing artifacts as MISSING', () => {
  const digest = sha256('REQ:MISSING')
  const store = new Store('/nonexistent-run')
  assert.equal(typeof store.digest(['REQ']), 'string')
  assert.equal(digest.length, 64)
})