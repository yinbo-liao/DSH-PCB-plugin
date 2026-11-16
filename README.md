# DSH PCB Plugin

A **DeepSeek Harness plugin** that turns PCB design into verifiable work: typed work packets, a
hash-chained evidence ledger, an independent gate monitor, and a deterministic geometry DRC.

It does not draw your board. It decides whether a board **may** proceed - and refuses when it
cannot prove it. That is the part that separates a demo from something you would send to a fab.

```
request -> S0 requirements -> S1 architecture -> S2 targets -> S3 tools
        -> S4 plan -> S5 risk & gap -> S6 layout -> G4 fabrication readiness
                 every gate signed by the monitor, never by the producer
```

## Install

Through the Plugin Manager (recommended), pointing at this repository:

```
plugin_manager install_bundle  ->  https://github.com/yinbo-liao/DSH-PCB-plugin
```

Or link a checkout for development:

```sh
git clone https://github.com/yinbo-liao/DSH-PCB-plugin
cd DSH-PCB-plugin
node --test "test/*.test.js"
```

The package declares `dsh.bundle.patch`, so installing it inserts the `dsh-pcb` plugin row into
the host composition (`cordis.patch.yml`), and the tools appear on the next mount.

### Configuration

Every tool takes explicit paths, so no configuration is required. The plugin row may set
defaults:

```yaml
- insert:
    - id: dsh-pcb
      name: '@yinbo-liao/dsh-pcb'
      config:
        runDir: runs/board-a
        boardDir: boards/board-a
        kicadPath: 'C:/Program Files/KiCad/9.0/bin/kicad-cli.exe'
```

## Tools

| Tool | Purpose |
|---|---|
| `pcb_init` | Create the run: artifact index + evidence ledger, and optionally record the ruleset baseline |
| `pcb_baseline` | Record `hw/board.kicad_dru` as the DRC baseline; **refuses to overwrite** without `force` |
| `pcb_register` | Hash an artifact file and bind it to a stage and a producing role |
| `pcb_approve` | Record a human approval bound to the artifact hash; editing the artifact voids it |
| `pcb_packet_open` | Open a typed packet: enforces stage order, budgets, role tool scope and input hashes |
| `pcb_packet_close` | Close a packet; outputs must be produced by that role, in that role's scope |
| `pcb_verify` | Run the monitor over G0-G4, record evidence, return PASS / HOLD / REFUSED |
| `pcb_geometry_drc` | Deterministic subset DRC: clearance, track width, annular ring, edge, floating pads |
| `pcb_trace` | Requirement traceability matrix and `match_score` |
| `pcb_doctor` | Ledger chain, hash drift, toolkit availability, gate set |

### What the gates check

| Gate | Signs off |
|---|---|
| G0 scope frozen | requirements with numeric thresholds, non-goals, envelope, assumptions, human approval |
| G1 architecture and parts | power budget with margin, derating, BOM lines resolved |
| G2 targets, tools, plan | every must-have has a criterion; every gate check maps to a deterministic tool |
| G3 risk and gap closure | risks at RPN >= 60 mitigated; no missing or contradicted requirement |
| G4 fabrication readiness | kicad-cli DRC, geometry DRC, netlist parity, export parity, footprint record, unmodified ruleset |

## Quick start with the bundled example

`examples/ldo3v3/` is a real 5 V to 3.3 V, 300 mA, two-layer supply board (12 parts), authored
as a netlist plus a board model.

```js
pcb_init      { runDir: 'runs/a', board: 'LDO3V3', boardDir: 'examples/ldo3v3' }
pcb_register  { runDir: 'runs/a', id: 'REQ', path: 'examples/ldo3v3/REQ.json', stage: 'S0', producer: 'requirements-analyst' }
pcb_register  { ... }                       // ARCH, POWER, BOM, TARGETS, TOOLS, RISK, GAP, PCB, NETLIST ...
pcb_approve   { runDir: 'runs/a', artifact: 'REQ', approver: 'you' }
pcb_verify    { runDir: 'runs/a', boardDir: 'examples/ldo3v3', until: 'G4' }
```

Measured outcome on a machine **without** KiCad:

```
G0 scope frozen                  PASS
G1 architecture and parts        PASS
G2 targets, tools, plan          PASS
G3 risk and gap closure          PASS
G4 fabrication readiness         HOLD  not_run (never counted as pass): kicad-cli unavailable
  B2g_geometry          pass      0 violations
  B3g_netlist_parity    pass      5 nets, 23 pads
  C7_footprint_record   pass      7 footprints verified
  B4_ruleset            pass      ruleset matches baseline
  B2_kicad_drc          not_run   the only blocker
```

Install KiCad (or pass `kicadPath`) and G4 re-runs the real DRC; exit code 0 turns it into
PASS. **`not_run` is never converted to a pass** - a board is not called fab-ready on evidence
that does not exist.

## Artifact contract

The tools read the same JSON artifacts the companion Python harness writes, so the formats are
interchangeable:

| File | Holds |
|---|---|
| `REQ.json` | requirements: id, priority, threshold, unit, verification, design element |
| `TARGETS.json` | criteria: threshold, method, instrument, `test_planned` |
| `POWER.json` | rails, loads, margin, thermal calculation |
| `DERATE.json` | component ratings versus applied stress |
| `BOM.json` | lines with MPN, package, lifecycle, datasheet, alternates |
| `RISK.json` | risks with severity/likelihood/detectability, RPN, mitigation, residual |
| `TOOLS.json` | per-check tool, determinism, strength, blind spots, gate mapping |
| `GAP.json` | gap register and improvement plan |
| `hw/board.json` | placements, routes, vias, rules - the authoritative board model |
| `hw/netlist.json` | nets and pads - connectivity intent |
| `hw/FOOTPRINTS.json` | footprint verification record against a source |
| `hw/board.kicad_dru` | DRC ruleset, hashed as the baseline |
| `hw/board.kicad_pcb` | derived export, so KiCad can open the board and run its own DRC |

## Design rules this plugin enforces

1. **The producer never approves its own work.** `approve`, `waive` and `verify` are reserved;
   the router adds them to every producer's deny list, and the attempt is recorded.
2. **Evidence is hash-bound and goes stale.** The live release digests the files on disk, so
   editing an artifact after a gate passed invalidates that gate.
3. **Gate signatures cover only their own artifacts.** Adding a later stage does not invalidate
   an earlier gate; changing one of its inputs does.
4. **`not_run` is never `pass`.** The monitor maps a missing tool to HOLD with the blocker named.
5. **A relaxed ruleset is refused, not failed.** The baseline check distinguishes "the board is
   wrong" from "the rules were changed to make the board look right".
6. **Deterministic checks outrank model judgement.** Every gate-critical check names a tool with
   a determinism class and a strength; a weak or LLM-only check cannot close a gate.

## What is verified, and what is not

Verified by this repository's tests (30 tests):

- ledger tamper detection (edit and deletion), live release digest, freshness
- per-artifact gate digests and gate staleness
- clearance/width/annular/edge/floating-pad checks, with a real injected violation
- netlist and export parity
- approval voiding when the payload changes, ruleset refusal
- stage ordering, budgets, reserved-tool denial
- the full S0-G4 flow on the example board, including `not_run` handling
- every tool spec compiles through the **real** `@deepseek-ai/dsh-tools` `defineTool`

Not verified - stated plainly:

- **kicad-cli DRC against a real KiCad install.** The adapter is exercised through its decision
  table and a mocked exit code; the suite expects `not_run` when KiCad is absent.
- **KiCad loadability of the exported `.kicad_pcb`.** The export is checked against the model by
  this repository's own s-expression reader, not by KiCad.
- **Signal integrity, power integrity, EMC, impedance control.** No tool here can see them; the
  checks are labelled `medium` strength and the gate set names what it checks.
- **Supplier existence of BOM MPNs.** There is no parts API; `C5` verifies that the record is
  complete, not that the part is in stock.

## Development

```sh
node --test "test/*.test.js"                                  # normal machines
node --test --test-isolation=none "test/*.test.js"            # restricted sandboxes
DSH_TOOLS_PATH=file:///path/to/dsh-tools/lib/index.js node test/sdk.integration.test.js
```

The SDK integration test skips itself when the module is unavailable, so the suite stays green
in a plain checkout while still proving compatibility where DSH is installed.

## Layout

```
index.js              plugin entry: apply(ctx, config) -> disposer
src/plugin.js         the ten tools
src/config.js         stages, roles, budgets, gate artifacts, envelope
src/core.js           artifact store + hash-chained ledger
src/router.js         packets, scopes, budgets, gate staleness
src/checks.js         Class A / B / C checks
src/geom.js           geometry engine + .kicad_pcb reader
src/parity.js         netlist <-> board <-> export
src/kicad.js          kicad-cli adapter (fails closed)
src/gates.js          gate table, monitor, verdict, report
src/trace.js          traceability matrix and match score
examples/ldo3v3/      a complete example board and its artifacts
test/                 30 tests, including red-team cases
```

## Related

The design this implements - stage contracts, evidence discipline, red-team cases - is in the
companion knowledge base, `09-agent/` (agent specification, monitor charter, trial test
protocol). This plugin is the executable subset of that design.

## Licence

MIT.