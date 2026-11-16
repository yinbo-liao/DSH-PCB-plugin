# Recorded run - LDO3V3

Produced by `node scripts/record-run.mjs --kicad <path>` on 2026-11-16 with **kicad-cli 10.0.8**,
against the board committed in `examples/ldo3v3`.

| Gate | Verdict |
|---|---|
| G0 scope frozen | PASS |
| G1 architecture and parts | PASS |
| G2 targets, tools, plan | PASS |
| G3 risk and gap closure | PASS |
| G4 fabrication readiness | **PASS** - real `kicad-cli pcb drc`, 0 errors |

S7 is **not** executed: no board has been fabricated, so all seven criteria are `not_run`.

Files: `TRANSCRIPT.json` (gate verdicts and per-check detail), `MONITOR.md` (the monitor's own
report), `DRC.rpt` (error-level report used for the verdict), `DRC.all.rpt` (all severities,
for triage - see `examples/ldo3v3/hw/DRC-TRIAGE.md`).