# Bench procedure - LDO3V3 trial test (S7)

Nothing in this file has been executed. **No board exists yet and no measurement has been
taken**; the values in `MEASUREMENTS.csv` are empty on purpose, so the trial test reports
`not_run` for every criterion. Fill them on a bench, then run `pcb_trial_test`.

## Safety first

1. Current-limited supply for the first power-up: 5.0 V, limit 200 mA.
2. Confirm no rail-to-ground short **before** power: > 1 kohm on 5 V and 3.3 V to GND.
3. Do not exceed 5.5 V input. The AMS1117 dissipates `(Vin - 3.3) x I`; at 5.5 V / 300 mA
   that is 0.66 W and the board is designed for it, but not for 12 V.

## Instruments

| Measurement | Instrument | Accuracy needed |
|---|---|---|
| Rail voltage | bench DMM, 4-wire at TP2 | <= 0.05 % + 3 counts |
| Load current | DMM on the electronic load, or the supply readout | 1 % |
| Power-up overshoot | scope, 100 MHz, 1 ms/div | 3 % |
| Regulator temperature | K thermocouple on the U1 tab | +/- 1.5 C |
| Continuity | DMM continuity mode | n/a |
| Board size | caliper | 0.02 mm |

## Steps

| # | Step | Record on |
|---|---|---|
| 1 | Visual inspection at 10x: bridges, missing parts, tombstoning | BRINGUP notes |
| 2 | Continuity: every TP to its net; no 5 V-GND short | CRIT-04 |
| 3 | Power-up at 5.0 V, 200 mA limit; capture inrush and overshoot | NEG-01 |
| 4 | Measure 3.3 V at TP2 at 100 / 200 / 300 mA | CRIT-02 |
| 5 | Drop input to 5.0 V at 300 mA; re-measure | CRIT-03 |
| 6 | Reverse the input at 5 V; measure current | CRIT-01 |
| 7 | Soak 10 min at 300 mA; thermocouple on the U1 tab; Tj = Tc + P x Rth_jc | CRIT-05 |
| 8 | Caliper the outline on three boards | CRIT-06 |

## Filling the CSV

`MEASUREMENTS.csv` columns:

```
criterion,board,value,unit,instrument,uncertainty,note
```

- one row per criterion per board; the **worst** verdict wins across boards
- `instrument` and `uncertainty` are mandatory for any pass/marginal/fail
- a criterion left empty becomes `not_run` and blocks G5
- a value inside the limit but within 10 % of it is `marginal`, not `pass`

Then:

```
pcb_register { runDir, id: 'TESTPLAN', path: 'examples/ldo3v3/BENCH.md', stage: 'S7', producer: 'test-engineer' }
pcb_trial_test { runDir, boardDir: 'examples/ldo3v3', measurementsPath: 'examples/ldo3v3/MEASUREMENTS.csv' }
pcb_register { runDir, id: 'RESULTS', path: 'examples/ldo3v3/RESULTS.json', stage: 'S7', producer: 'test-engineer' }
pcb_verify   { runDir, boardDir: 'examples/ldo3v3', until: 'G6' }
```