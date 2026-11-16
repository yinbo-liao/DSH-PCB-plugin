# DRC warning triage - LDO3V3

The gate requires **zero error-level DRC violations**. Warnings are recorded and triaged here.

Produced with `kicad-cli 10.0.8`:

```
kicad-cli pcb drc --severity-error --exit-code-violations --refill-zones -o DRC.rpt board.kicad_pcb   # exit 0
kicad-cli pcb drc --severity-all -o DRC.all.rpt board.kicad_pcb                                        # 12 warnings
```

| Warning | Count | Triage |
|---|---|---|
| `lib_footprint_issues`: "the current configuration does not include the footprint library 'pcbh'" | 12 | **Accepted.** These are custom footprints authored from a board model, not copied from a library. The library nickname `pcbh` exists only in the export. Fabrication uses the pads embedded in the `.kicad_pcb`, so this warning has no manufacturing effect. To silence it, add a project `fp-lib-table` and a `.pretty` library. |

Warnings fixed while closing the gate (each was a real defect in the exporter, not in the design):

| Was | Cause | Fix |
|---|---|---|
| `shorting_items` 5V/GND | the exporter wrote footprints at rotation 0, so U1's 180° pads landed on the GND drop | carry the placement rotation into the footprint |
| `silk_over_copper`, `silk_overlap`, `silk_edge_clearance` | property text positions were written as absolute coordinates inside a footprint, where they are relative | emit relative offsets, per footprint |
| `track_dangling` x2 | the GND and 3V3 trunks ended in mid-air | terminate every trunk on a pad or another track end |