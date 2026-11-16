/**
 * Packet router: typed packets, role scopes, budgets and stage ordering.
 *
 * A packet is the only way work is handed to a role. It carries input hashes, an exit
 * condition and a budget, and the router enforces what a prompt cannot: scope, ordering,
 * budget, deny lists, and gate staleness.
 * @module dsh-pcb/src/router
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUDGETS, GATE_ARTIFACTS, RESERVED_TOOLS, ROLE_SCOPES, STAGE_PRE_GATE, STAGES } from './config.js'
import { nowIso, readJson } from './core.js'

export class RouterError extends Error {}

export class Router {
  constructor(run) {
    this.run = run
    this.statePath = run.statePath()
  }

  state() {
    return this.run.state()
  }

  saveState(state) {
    this.run.saveState(state)
  }

  gateStatus(gate) {
    const record = this.state().gates[gate]
    return record && typeof record === 'object' ? record.verdict : record
  }

  gateDigest(gate) {
    const record = this.state().gates[gate]
    return record && typeof record === 'object' ? record.digest : null
  }

  setGate(gate, verdict, digest) {
    const state = this.state()
    state.gates[gate] = { verdict, digest, at: nowIso() }
    this.saveState(state)
  }

  openPacket({ stage, role, objective, inputs = {}, exitCriteria = [], deniedTools = [], budget = {}, note = '' }) {
    if (!STAGES.includes(stage)) throw new RouterError(`unknown stage ${stage}`)
    if (!ROLE_SCOPES[role]) throw new RouterError(`unknown role ${role}`)

    const pre = STAGE_PRE_GATE[stage]
    if (pre && this.gateStatus(pre) !== 'PASS') {
      throw new RouterError(`stage ${stage} blocked: gate ${pre} is ${this.gateStatus(pre) ?? 'not evaluated'}`)
    }
    if (pre) {
      const signed = this.gateDigest(pre)
      const live = this.run.store.digest(GATE_ARTIFACTS[pre])
      if (signed && signed !== live) {
        throw new RouterError(`stage ${stage} blocked: gate ${pre} is STALE - signed over ${signed.slice(0, 12)} but its artifacts are now ${live.slice(0, 12)}; re-run verify`)
      }
    }

    const state = this.state()
    const use = state.stages[stage] ?? { iterations: 0, tool_calls: 0 }
    if (use.iterations >= BUDGETS.stage.iterations) {
      throw new RouterError(`stage ${stage} budget exhausted (${use.iterations}/${BUDGETS.stage.iterations} iterations)`)
    }

    const stale = []
    for (const [id, expected] of Object.entries(inputs)) {
      let actual
      try {
        actual = this.run.store.fileHash(id)
      } catch {
        stale.push(`${id}: not registered`)
        continue
      }
      if (expected && actual !== expected) stale.push(`${id}: hash ${actual.slice(0, 12)} != expected ${expected.slice(0, 12)}`)
    }
    if (stale.length) throw new RouterError(`STALE_INPUT: ${stale.join('; ')}`)

    const scope = ROLE_SCOPES[role]
    const denied = new Set(deniedTools)
    if (!['monitor-verifier', 'human-approver'].includes(role)) for (const t of RESERVED_TOOLS) denied.add(t)
    const granted = scope.tools.filter(t => !denied.has(t))

    const packetId = `${stage}-${role.toUpperCase().replaceAll(/[^A-Z]/g, '')}-${Math.random().toString(16).slice(2, 8)}`
    const packet = {
      packet_id: packetId,
      stage,
      role,
      objective,
      inputs,
      exit_criteria: exitCriteria,
      allowed_tools: granted,
      denied_tools: [...denied].sort(),
      writable_artifacts: scope.writes,
      budget: { ...BUDGETS.packet, ...budget },
      used: { iterations: 0, tool_calls: 0 },
      status: 'open',
      opened: nowIso(),
      note,
    }
    mkdirSync(this.run.packetsDir, { recursive: true })
    writeFileSync(join(this.run.packetsDir, `${packetId}.json`), `${JSON.stringify(packet, null, 2)}\n`, 'utf8')

    state.packets[packetId] = { stage, role, status: 'open' }
    state.stages[stage] = { iterations: use.iterations + 1, tool_calls: use.tool_calls }
    this.saveState(state)
    this.run.ledger.append('packet_open', { packet_id: packetId, stage, role, objective, inputs })
    return packet
  }

  closePacket(packetId, { status = 'done', outputs = [], note = '' } = {}) {
    const path = join(this.run.packetsDir, `${packetId}.json`)
    if (!existsSync(path)) throw new RouterError(`unknown packet ${packetId}`)
    const packet = readJson(path)
    if (packet.status !== 'open') throw new RouterError(`packet ${packetId} is ${packet.status}, not open`)
    if (!['done', 'blocked', 'escalated'].includes(status)) throw new RouterError(`invalid close status ${status}`)

    const problems = []
    for (const id of outputs) {
      let record
      try {
        record = this.run.store.get(id)
      } catch {
        problems.push(`${id}: not registered`)
        continue
      }
      if (record.producer !== packet.role) problems.push(`${id}: producer ${record.producer} != packet role ${packet.role}`)
      if (!packet.writable_artifacts.includes(id)) problems.push(`${id}: not in role's writable scope`)
    }
    if (problems.length && status === 'done') throw new RouterError(`output contract violated: ${problems.join('; ')}`)

    packet.status = status
    packet.closed = nowIso()
    packet.outputs = outputs
    packet.close_note = note
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, 'utf8')

    const state = this.state()
    state.packets[packetId] = { stage: packet.stage, role: packet.role, status }
    this.saveState(state)
    this.run.ledger.append('packet_close', { packet_id: packetId, status, outputs, note })
    return packet
  }

  recordToolCall(packetId, tool, ok, detail = '') {
    const path = join(this.run.packetsDir, `${packetId}.json`)
    const packet = readJson(path)
    if (packet.denied_tools.includes(tool)) {
      this.run.ledger.append('tool_denied', { packet_id: packetId, tool, reason: 'explicitly denied', detail })
      throw new RouterError(`tool ${tool} is explicitly denied for this packet`)
    }
    if (!packet.allowed_tools.includes(tool)) {
      this.run.ledger.append('tool_denied', { packet_id: packetId, tool, reason: 'not in allowlist', detail })
      throw new RouterError(`tool ${tool} is not allowed for ${packet.role} (denied by scope)`)
    }
    packet.used.tool_calls += 1
    if (packet.used.tool_calls > packet.budget.tool_calls) throw new RouterError(`packet ${packetId} tool budget exhausted`)
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, 'utf8')
    return this.run.ledger.append('tool_call', { packet_id: packetId, tool, ok, detail })
  }
}