# Monitor verdict

- board: **LDO3V3**
- release_id: `2db515ff5922985be6857b0350afcd0a`
- generated: 2026-11-16T21:26:52+08:00
- chain: `{"ok":true,"records":42,"head":"f3e29baf19d523df7cb8e12c14221a6413d5d1963a5e6c1b781840131ba8449a"}`

A `not_run` check is never a pass. PASS requires every required check to be pass.

| gate | name | verdict | reason |
|---|---|---|---|
| G0 | scope frozen | **PASS** | all required checks passed with fresh evidence |
| G1 | architecture and parts | **PASS** | all required checks passed with fresh evidence |
| G2 | targets, tools, plan | **PASS** | all required checks passed with fresh evidence |
| G3 | risk and gap closure | **PASS** | all required checks passed with fresh evidence |
| G4 | fabrication readiness (MVP set) | **PASS** | all required checks passed with fresh evidence |

## Check detail

### G0 - PASS

| check | status | strength | detail |
|---|---|---|---|
| C0_approval | pass | strong | approved by operator at 2026-11-16T21:26:46+08:00 |

### G1 - PASS

| check | status | strength | detail |
|---|---|---|---|
| C3_power_budget | pass | medium | 2 rail(s) within margin |
| C4_derating | pass | medium | 9 items within derating |
| C5_parts_resolved | pass | medium | 12 BOM lines resolved |

### G2 - PASS

| check | status | strength | detail |
|---|---|---|---|
| C8_criteria_coverage | pass | strong | 6 must-haves, all with criteria |
| C9_tool_coverage | pass | strong | every gate check maps to a deterministic tool |

### G3 - PASS

| check | status | strength | detail |
|---|---|---|---|
| C10_risk_mitigated | pass | medium | 7 risks within threshold |
| C1_traceability | pass | strong | match_score 0.2 over 6 must-haves, counts {"unverified":6} |

### G4 - PASS

| check | status | strength | detail |
|---|---|---|---|
| B2_kicad_drc | pass | strong | DRC 0 errors, 12 warning(s) recorded for triage |
| B2g_geometry | pass | medium | 0 violation(s) across clearance/width/annular/edge/unconnected |
| B3g_netlist_parity | pass | medium | netlist and board agree (5 nets, 23 pads) |
| B3x_export_parity | pass | medium | export matches model positionally (50 items, 0.01 mm) |
| C7_footprint_record | pass | medium | all 7 footprints verified against a source |
| B4_ruleset | pass | strong | ruleset matches baseline |

