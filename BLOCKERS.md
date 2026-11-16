# Blockers - what this environment cannot do, and what unblocks it

Recorded rather than hidden: these are the two steps that cannot be completed on the machine
where this plugin was built. Everything else in the repository is verified.

## B-01 - KiCad: RESOLVED 2026-11-16 (was: cannot be installed here)

**Resolution:** a KiCad 10.0.8 installation at `Y:\kicad` was supplied by the operator, and
`node scripts/record-run.mjs --kicad Y:\kicad\bin\kicad-cli.exe` produced **G4 PASS** with a real
`kicad-cli pcb drc` (0 errors, 12 triaged warnings). Recorded in
`docs/recorded-runs/ldo3v3/`.

Closing it also exposed three real bugs, all fixed: the exporter discarded footprint rotation
(which had produced a genuine 5V/GND short), property text was written in absolute coordinates
inside a footprint, and the adapter used piped stdio that this sandbox refuses (EPERM).

The original blocker analysis is kept below because it explains why the run needs an operator
to supply the path.

`B2_kicad_drc` is `not_run`, which means G4 holds. That is the correct behaviour: the gate does
not claim a board is fab-ready on evidence that does not exist.

### What was checked (2026-11-16)

| Probe | Result |
|---|---|
| `IsInRole(Administrator)` | **false** |
| Write to `C:\Program Files` | access denied |
| Known install paths (`KiCad`, `8.0`, `9.0`, `D:\KiCad`, `bin`) | none exist |
| Uninstall registry (HKLM, WOW6432Node, HKCU) | no KiCad entry |
| `where.exe kicad-cli` | not found |
| `*.kicad_pcb` / `*.kicad_sch` on `D:` | none |
| `7z` / `7za` for NSIS extraction | missing (only `tar.exe`, which cannot extract NSIS) |
| `downloads.kicad.org` installer listing | 404 / no direct `.exe` link discoverable |
| `winget` | stub only; `Get-AppxPackage` access denied |

The chain fails at the first step: a machine-wide installer needs administrator rights and a
writable `C:\Program Files`, and a portable extraction needs an NSIS-capable extractor that is
not present. KiCad does not ship an official portable `kicad-cli`.

### What unblocks it

1. Install KiCad on a machine with administrator rights, then re-run:
   ```
   pcb_verify { runDir, boardDir: 'examples/ldo3v3', until: 'G4' }
   ```
2. Or point at an existing install without touching PATH:
   ```
   pcb_verify { runDir, boardDir: 'examples/ldo3v3', until: 'G4', kicadPath: 'C:/Program Files/KiCad/9.0/bin/kicad-cli.exe' }
   ```
3. Or run `node scripts/record-run.mjs --kicad <path>` to record the whole flow in one command.

When KiCad is present, expect one of two outcomes, and **both are informative**:
- exit code 0 -> G4 becomes PASS;
- a parse error on `hw/board.kicad_pcb` -> the export is invalid and must be fixed. The board
  model (`board.json`) remains the authoritative artifact, so this is a bug in `boardgen`, not
  in the design.

## B-02 - No physical board, so S7 has no real measurements

The trial test is implemented and tested, but `examples/ldo3v3/MEASUREMENTS.csv` is intentionally
empty: no LDO3V3 board has been fabricated or measured. Consequently `pcb_trial_test` reports
`not_run` for every criterion, G5 holds, and `match_score` stays low - which is the honest state
of an unbuilt board.

### What unblocks it

Fabricate the board, follow `examples/ldo3v3/BENCH.md`, fill `MEASUREMENTS.csv`, then:
```
pcb_trial_test { runDir, boardDir: 'examples/ldo3v3', measurementsPath: 'examples/ldo3v3/MEASUREMENTS.csv' }
pcb_verify     { runDir, boardDir: 'examples/ldo3v3', until: 'G6' }
```

## Never done in this repository

- No measurement in `test/fixtures/*.csv` is real. Every row carries `SYNTHETIC value for tests`
  in its note column, and the tests assert the verdict logic, not the numbers.
- No gate verdict in this repository has ever been produced with KiCad present.