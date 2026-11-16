/**
 * kicad-cli adapter. The only place that runs an external process, and the only place that
 * decides whether an absent tool becomes `not_run` rather than `pass`.
 *
 * Captured runs redirect stdout/stderr to a file descriptor instead of pipes: some sandboxes
 * refuse named pipes for child processes (EPERM), and a file works everywhere. The exit code
 * plus the report file are what the gate consumes either way.
 * @module dsh-pcb/src/kicad
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const isWindows = process.platform === 'win32'

/** Run a command, capturing output through a file descriptor rather than a pipe. */
function runCaptured(command, args, { workDir, timeoutMs = 20000 } = {}) {
  const dir = workDir ?? tmpdir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* fall back to the OS temp dir below */
  }
  const logPath = join(dir, `kicad-cli-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.log`)
  let fd
  let proc
  try {
    fd = openSync(logPath, 'w')
    proc = spawnSync(command, args, { stdio: ['ignore', fd, fd], timeout: timeoutMs })
  } catch (error) {
    return { status: null, error, output: '' }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
  let output = ''
  try {
    if (existsSync(logPath)) output = readFileSync(logPath, 'utf8')
  } catch {
    output = ''
  }
  try { rmSync(logPath, { force: true }) } catch { /* best effort */ }
  return { status: proc.status, error: proc.error, output: output.trim() }
}

/** Locate kicad-cli. An explicit `kicadPath` wins over PATH lookup. */
export function detectKicad({ kicadPath, workDir } = {}) {
  if (kicadPath) {
    const result = runCaptured(kicadPath, ['version'], { workDir, timeoutMs: 20000 })
    if (result.error || result.status !== 0) {
      return {
        available: false, path: kicadPath, version: null,
        reason: `cannot execute ${kicadPath}: ${result.error ? result.error.message : `exit ${result.status}`}`,
      }
    }
    return { available: true, path: kicadPath, version: result.output.split('\n')[0] || 'unknown', reason: '' }
  }
  const which = isWindows ? 'where' : 'which'
  const found = runCaptured(which, ['kicad-cli'], { workDir, timeoutMs: 20000 })
  const candidate = found.status === 0 ? found.output.split(/\r?\n/)[0] : ''
  if (!candidate) return { available: false, path: null, version: null, reason: 'kicad-cli not found on PATH' }
  const version = runCaptured(candidate, ['version'], { workDir, timeoutMs: 20000 })
  return {
    available: version.status === 0,
    path: candidate,
    version: version.status === 0 ? (version.output.split('\n')[0] || 'unknown') : null,
    reason: version.status === 0 ? '' : `version probe failed: exit ${version.status}`,
  }
}

/**
 * Run `kicad-cli pcb drc`. Returns `not_run` when kicad-cli is unavailable - never `pass`.
 * Covers both sandbox realities: a missing tool, and a tool that cannot write its own registry
 * settings (kicad-cli logs that to stderr but still runs).
 */
export function runDrc(pcbPath, reportPath, options = {}) {
  const info = detectKicad(options)
  if (!info.available) {
    return { available: false, status: 'not_run', exit_code: null, command: null, version: null, reason: info.reason }
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  // The verdict is error-level only; every warning is still recorded in a second report.
  // A board may pass on zero errors, but nobody can claim it is warning-free.
  const args = ['pcb', 'drc', '--severity-error', '--exit-code-violations', '--refill-zones', '-o', reportPath, pcbPath]
  const proc = runCaptured(info.path, args, { workDir: options.workDir, timeoutMs: 600000 })
  if (proc.error) {
    return {
      available: true, version: info.version, command: [info.path, ...args].join(' '),
      exit_code: null, status: 'fail', stderr: `spawn failed: ${proc.error.message}`,
    }
  }
  const allReport = reportPath.replace(/\.rpt$/, '') + '.all.rpt'
  runCaptured(info.path, ['pcb', 'drc', '--severity-all', '-o', allReport, pcbPath], { workDir: options.workDir, timeoutMs: 600000 })
  // The count lives in the report body ("** Found N DRC violations **"), not on stdout.
  let warnings = null
  try {
    const found = /Found (\d+) DRC violations/.exec(readFileSync(allReport, 'utf8'))
    warnings = found ? Number(found[1]) : null
  } catch {
    warnings = null
  }
  return {
    available: true,
    version: info.version,
    command: [info.path, ...args].join(' '),
    exit_code: proc.status,
    status: proc.status === 0 ? 'pass' : 'fail',
    stdout: proc.output.slice(-4000),
    report: reportPath,
    warnings_report: allReport,
    warnings,
  }
}