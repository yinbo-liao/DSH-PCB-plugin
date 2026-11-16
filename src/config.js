/**
 * Static configuration: stages, gates, roles, budgets, competence envelope.
 * @module dsh-pcb/src/config
 */
export const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']

export const STAGE_NAMES = {
  S0: 'task definition',
  S1: 'device and function evaluation',
  S2: 'target evaluation',
  S3: 'tools evaluation',
  S4: 'task steps and planning',
  S5: 'risk and loop check + gap analysis',
  S6: 'best solution implementation',
  S7: 'trial test of the PCB',
  S8: 'results evaluation',
  S9: 'deep understanding + monitor verification',
}

/** Gate that must be PASS before a stage may open work. */
export const STAGE_PRE_GATE = {
  S0: null, S1: 'G0', S2: 'G1', S3: 'G1', S4: 'G1', S5: 'G2', S6: 'G3', S7: 'G4', S8: 'G5', S9: 'G6',
}

/** Role -> allowed tools and writable artifact ids. Enforced by the registry, not the prompt. */
export const ROLE_SCOPES = {
  supervisor: {
    tools: ['read', 'ledger', 'store', 'escalate'],
    writes: ['PLAN', 'RISK', 'GAP', 'LOOPLOG', 'DECISION', 'EVAL'],
  },
  'requirements-analyst': {
    tools: ['read', 'kb', 'datasheet_fetch', 'store'],
    writes: ['REQ', 'ASSUMPTIONS', 'ENVELOPE', 'NONGOALS', 'QUESTIONS', 'TARGETS'],
  },
  architect: {
    tools: ['read', 'calc', 'datasheet_fetch', 'store'],
    writes: ['ARCH', 'IFACE', 'POWER'],
  },
  'part-scout': {
    tools: ['read', 'parts_api', 'datasheet_fetch', 'store'],
    writes: ['BOM', 'DERATE'],
  },
  'tool-scout': {
    tools: ['read', 'probe_tool', 'store'],
    writes: ['TOOLS'],
  },
  'layout-engineer': {
    tools: ['read', 'eda_edit', 'drc_run', 'sandbox_script', 'store'],
    writes: ['SCH', 'PCB', 'NETLIST', 'ERC', 'DRC', 'STACKUP', 'FOOTPRINT_RECORD', 'RULESET'],
  },
  'dfm-reviewer': {
    tools: ['read', 'dfm_check', 'store'],
    writes: ['DFM'],
  },
  'test-engineer': {
    tools: ['read', 'measure', 'store'],
    writes: ['TESTPLAN', 'RESULTS', 'BRINGUP'],
  },
  'monitor-verifier': {
    tools: ['read', 'drc_run', 'verify', 'store'],
    writes: ['MONITOR'],
  },
  'human-approver': {
    tools: ['read', 'approve', 'waive'],
    writes: ['APPROVAL', 'WAIVER'],
  },
  'knowledge-curator': {
    tools: ['read', 'kb_write', 'store'],
    writes: ['RETRO', 'RULEPATCH'],
  },
}

/** Actions a producer may never perform on its own work. */
export const RESERVED_TOOLS = ['approve', 'waive', 'verify']

export const BUDGETS = {
  packet: { iterations: 3, tool_calls: 25, wall_clock_min: 20 },
  stage: { iterations: 8, tool_calls: 60, wall_clock_min: 90 },
  task: { iterations: 40, tool_calls: 300, wall_clock_min: 480 },
}

/** What each gate is signed over: a gate is stale only when one of its own artifacts changes. */
export const GATE_ARTIFACTS = {
  G0: ['REQ', 'NONGOALS', 'ENVELOPE', 'ASSUMPTIONS'],
  G1: ['ARCH', 'IFACE', 'POWER', 'BOM', 'DERATE'],
  G2: ['TARGETS', 'TOOLS', 'PLAN'],
  G3: ['RISK', 'GAP', 'LOOPLOG', 'DECISION'],
  G4: ['PCB', 'NETLIST', 'FOOTPRINT_RECORD'],
}

/**
 * MVP gate set for G4. ERC and schematic parity need a schematic; the MVP board is authored
 * as netlist + board model, so those move to a later phase.
 */
export const MVP_GATES = {
  G4: ['B2_kicad_drc', 'B2g_geometry', 'B3g_netlist_parity', 'B3x_export_parity', 'C7_footprint_record'],
}

export const ENVELOPE_IN = [
  '2-4 layers', 'DC < 60 V', '< 3 A per rail', 'digital <= ~50 MHz',
  'I2C/SPI/UART/USB FS', 'audio-band analog', 'proto to small series', 'JLCPCB-class fab',
]

export const ENVELOPE_OUT = [
  'mains', '> 60 V', 'RF', 'USB HS/SS / DDR / > 1 Gb/s differential',
  'precision low-noise analog', 'safety-critical / medical / automotive',
  'CE / FCC / UL certification',
]