/**
 * Integration test against a real kicad-cli.
 *
 * Skipped unless DSH_KICAD_PATH points at a kicad-cli executable, so the suite stays green in a
 * plain checkout while still proving the adapter against the real tool where one is installed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkTemp, REPO } from './helpers.js'

const KICAD = process.env.DSH_KICAD_PATH

test('real kicad-cli reports zero DRC errors on the example board', async t => {
  if (!KICAD) {
    t.skip('set DSH_KICAD_PATH to run this test against a real kicad-cli')
    return
  }
  const { b2KicadDrc } = await import('../src/checks.js')
  const { dir, cleanup } = mkTemp('kicad')
  try {
    const res = b2KicadDrc(
      join(REPO, 'examples', 'ldo3v3', 'hw', 'board.kicad_pcb'),
      join(dir, 'DRC.rpt'),
      { kicadPath: KICAD, workDir: dir },
    )
    assert.equal(res.status, 'pass', res.detail)
    assert.equal(res.tool_version !== null, true, 'the tool version must be recorded')
    assert.match(res.detail, /0 errors/)
    assert.equal(typeof res.data.warnings, 'number')
    assert.ok(res.data.warnings_report.endsWith('.all.rpt'))
  } finally { cleanup() }
})

test('a missing kicad-cli is not_run, never pass', async t => {
  const { detectKicad } = await import('../src/kicad.js')
  const info = detectKicad({ kicadPath: join(REPO, 'does-not-exist', 'kicad-cli') })
  assert.equal(info.available, false)
  t.diagnostic(`reason: ${info.reason}`)
})