# Test plan - LDO3V3

Derived from `TARGETS.json`. The procedure, instruments and safety steps are in `BENCH.md`;
this file is the plan the gate G5 checks for.

| Criterion | Requirement | Test | Sample |
|---|---|---|---|
| CRIT-01 | REQ-01 | reverse input, measure current | 3 boards |
| CRIT-02 | REQ-02 | 3.3 V at three load steps | 3 boards |
| CRIT-03 | REQ-03 | 3.3 V at minimum input, full load | 3 boards |
| CRIT-04 | REQ-04 | continuity TP to net | 3 boards |
| CRIT-05 | REQ-05 | thermocouple on U1 tab after soak | 1 board |
| CRIT-06 | REQ-07 | caliper the outline | 3 boards |
| NEG-01 | REQ-02 | scope power-up overshoot | 3 boards |

Every must-have requirement has at least one criterion. `not_run` is a valid, recorded result
and never counts as a pass.