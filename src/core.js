/**
 * Content-addressed artifact store and hash-chained evidence ledger.
 *
 * Two invariants hold here:
 *  - every artifact is content-addressed, so evidence cannot silently outlive the file it
 *    describes (`liveRelease` digests the files on disk, not the registration records);
 *  - the ledger is append-only and chained, so editing or deleting a record is detectable.
 *
 * @module dsh-pcb/src/core
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'

/** @returns {string} current time as an ISO-8601 string with offset. */
export function nowIso() {
  const d = new Date()
  const pad = n => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:`
    + `${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

/** Stable JSON bytes for hashing (sorted keys, no whitespace). */
export function canonical(obj) {
  const sort = value => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value).sort()) out[key] = sort(value[key])
      return out
    }
    return value
  }
  return JSON.stringify(sort(obj))
}

/** @returns {string} hex sha256 of a string or Buffer. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @returns {string} hex sha256 of a file's bytes. */
export function sha256File(path) {
  return sha256(readFileSync(path))
}

/** Read JSON with a clear error instead of an opaque parse failure. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read JSON artifact ${path}: ${error.message}`)
  }
}

/** Write JSON atomically (temp file + rename), UTF-8, LF endings. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Content-addressed artifact index for one board run. */
export class Store {
  /**
   * @param {string} root - run directory.
   * @param {string} [base] - project root for portable relative paths.
   */
  constructor(root, base) {
    this.root = root
    this.base = base ?? root
    this.indexPath = join(root, 'index.json')
    this.index = null
  }

  load() {
    if (this.index) return this.index
    this.index = existsSync(this.indexPath)
      ? readJson(this.indexPath)
      : { schema: 'pcbh/index/1', board: null, artifacts: {} }
    return this.index
  }

  save(index) {
    index.release_id = Store.digestOf(index)
    writeJson(this.indexPath, index)
    this.index = index
  }

  static digestOf(index) {
    const rows = Object.keys(index.artifacts).sort().map(id => `${id}:${index.artifacts[id].sha256}`)
    return sha256(rows.join('\n')).slice(0, 32)
  }

  init(board) {
    if (Object.keys(this.load().artifacts).length > 0) {
      throw new Error(`run already initialised at ${this.root}`)
    }
    const index = { schema: 'pcbh/index/1', board, created: nowIso(), artifacts: {} }
    this.save(index)
    return index
  }

  register(id, path, stage, producer) {
    if (!existsSync(path)) throw new Error(`artifact file not found: ${path}`)
    const index = this.load()
    const rel = relative(this.base, path)
    const stored = rel.startsWith('..') || isAbsolute(rel) ? path : rel.replaceAll('\\', '/')
    const record = {
      path: stored,
      sha256: sha256File(path),
      bytes: statSync(path).size,
      stage,
      producer,
      registered: nowIso(),
    }
    index.artifacts[id] = record
    this.save(index)
    return record
  }

  get(id) {
    const record = this.load().artifacts[id]
    if (!record) throw new Error(`artifact not registered: ${id}`)
    return record
  }

  path(id) {
    const stored = this.get(id).path
    return isAbsolute(stored) ? stored : join(this.base, stored)
  }

  fileHash(id) {
    return sha256File(this.path(id))
  }

  isFresh(id, recordedSha) {
    try {
      return this.fileHash(id) === recordedSha
    } catch {
      return false
    }
  }

  /** Digest over the live hashes of a named artifact set (gate signatures use this). */
  digest(ids) {
    const rows = [...new Set(ids)].sort().map(id => {
      let sha = 'MISSING'
      try {
        sha = this.fileHash(id)
      } catch {
        sha = 'MISSING'
      }
      return `${id}:${sha}`
    })
    return sha256(rows.join('\n')).slice(0, 32)
  }

  /** Digest over every registered artifact as it is on disk right now. */
  liveRelease() {
    return this.digest(Object.keys(this.load().artifacts))
  }

  missing(ids) {
    const have = this.load().artifacts
    return ids.filter(id => !(id in have))
  }
}

/** Append-only, hash-chained record of everything the workflow claimed. */
export class Ledger {
  constructor(root) {
    this.root = root
    this.path = join(root, 'ledger.jsonl')
    this.cache = null
  }

  read() {
    if (this.cache) return this.cache
    if (!existsSync(this.path)) {
      this.cache = []
      return this.cache
    }
    this.cache = readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line))
    return this.cache
  }

  reload() {
    this.cache = null
  }

  head() {
    const records = this.read()
    return records.length ? records.at(-1).hash : 'GENESIS'
  }

  append(kind, payload) {
    return this.appendMany([[kind, payload]])[0]
  }

  /** Append several records with one file open; file I/O dominates in sandboxes. */
  appendMany(items) {
    const records = this.read()
    let prev = records.length ? records.at(-1).hash : 'GENESIS'
    let seq = records.length
    const created = []
    for (const [kind, payload] of items) {
      seq += 1
      const record = { kind, seq, prev, timestamp: nowIso(), ...payload }
      record.hash = sha256(canonical(record))
      created.push(record)
      prev = record.hash
    }
    if (created.length) {
      mkdirSync(this.root, { recursive: true })
      writeFileSync(this.path, created.map(r => `${JSON.stringify(r)}\n`).join(''), { encoding: 'utf8', flag: 'a' })
      records.push(...created)
    }
    return created
  }

  /** Recompute every hash and link from disk; any edit or deletion breaks it. */
  verifyChain() {
    this.reload()
    let prev = 'GENESIS'
    const records = this.read()
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]
      const { hash, ...body } = record
      if (record.seq !== i + 1) return { ok: false, at: i + 1, reason: `sequence gap: expected ${i + 1}, got ${record.seq}` }
      if (record.prev !== prev) return { ok: false, at: i + 1, reason: 'broken link to previous record' }
      if (hash !== sha256(canonical(body))) return { ok: false, at: i + 1, reason: 'record content does not match its hash' }
      prev = hash
    }
    return { ok: true, records: records.length, head: prev }
  }

  evidence(gate, check) {
    return this.read().filter(r => r.kind === 'evidence'
      && (gate === undefined || r.gate === gate)
      && (check === undefined || r.check === check))
  }

  latest(gate, check) {
    return this.evidence(gate, check).at(-1)
  }

  counts() {
    const out = {}
    for (const record of this.read()) out[record.kind] = (out[record.kind] ?? 0) + 1
    return out
  }
}

/** One board run: store + ledger + directory conventions. */
export class Run {
  constructor(root, base) {
    this.root = root
    this.store = new Store(root, base)
    this.ledger = new Ledger(root)
    this.packetsDir = join(root, 'packets')
    this.reportsDir = join(root, 'reports')
    this.baselineDir = join(root, 'baseline')
  }

  init(board) {
    mkdirSync(this.root, { recursive: true })
    const index = this.store.init(board)
    this.ledger.append('run_init', { board, release_id: index.release_id })
    return index
  }

  statePath() {
    return join(this.root, 'state.json')
  }

  state() {
    return existsSync(this.statePath())
      ? readJson(this.statePath())
      : { schema: 'pcbh/state/1', stages: {}, gates: {}, packets: {} }
  }

  saveState(state) {
    writeJson(this.statePath(), state)
  }
}