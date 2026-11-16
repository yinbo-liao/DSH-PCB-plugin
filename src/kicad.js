/**
 * kicad-cli adapter. The only place that runs an external process, and the only place that
 * decides whether an absent tool becomes `not_run` rather than `pass`.
 * @module dsh-pcb/src/kicad
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const isWindows = process.platform === 'win32'

/** Run a probe process, treating a spawn failure (including sandbox EPERM) as "no answer". */
function probe(command, args) {
  try {
    const out = spawnSync(command, args, { encoding: 'utf8', timeout: 20000 })
    if (out.error) return { ok: false, reason: out.error.message, stdout: '' }
    return { ok: out.status === 0, reason: `exit ${out.status}`, stdout: (out.stdout || out.stderr || '').trim() }
  } catch (error) {
    return { ok: false, reason: error.message, stdout: '' }
  }
}

/** Locate kicad-cli. An explicit `kicadPath` wins over PATH lookup. */
export function detectKicad({ kicadPath } = {}) {
  if (kicadPath) {
    const result = probe(kicadPath, ['version'])
    if (!result.ok) return { available: false, path: kicadPath, version: null, reason: `cannot execute ${kicadPath}: ${result.reason}` }
    return { available: true, path: kicadPath, version: result.stdout.split('\n')[0] || 'unknown', reason: '' }
  }
  const which = isWindows ? 'where' : 'which'
  const found = probe(which, ['kicad-cli'])
  const candidate = found.ok ? found.stdout.split(/\r?\n/)[0] : ''
  if (!candidate) return { available: false, path: null, version: null, reason: 'kicad-cli not found on PATH' }
  const version = probe(candidate, ['version'])
  return {
    available: version.ok,
    path: candidate,
    version: version.ok ? (version.stdout.split('\n')[0] || 'unknown') : null,
    reason: version.ok ? '' : `version probe failed: ${version.reason}`,
  }
}

/**
 * Run `kicad-cli pcb drc`. Returns `not_run` when kicad-cli is unavailable - never `pass`.
 * @returns {{status: 'pass'|'fail'|'not_run', exit_code: number|null, command: string|null, version: string|null, available: boolean, reason?: string, stdout?: string}}
 */
export function runDrc(pcbPath, reportPath, options = {}) {
  const info = detectKicad(options)
  if (!info.available) {
    return { available: false, status: 'not_run', exit_code: null, command: null, version: null, reason: info.reason }
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  const args = ['pcb', 'drc', '--exit-code-violations', '--refill-zones', '-o', reportPath, pcbPath]
  let proc
  try {
    proc = spawnSync(info.path, args, { encoding: 'utf8', timeout: 600000 })
  } catch (error) {
    return { available: true, version: info.version, command: [info.path, ...args].join(' '), exit_code: null, status: 'fail', stderr: `spawn failed: ${error.message}` }
  }
  const exitCode = proc.status
  return {
    available: true,
    version: info.version,
    command: [info.path, ...args].join(' '),
    exit_code: exitCode,
    status: exitCode === 0 ? 'pass' : 'fail',
    stdout: (proc.stdout ?? '').slice(-4000),
    stderr: (proc.stderr ?? '').slice(-4000),
    report: reportPath,
  }
}