# Architecture - LDO3V3

Linear topology, chosen over a buck because the load is 300 mA and the 1.7 V drop is
manageable with copper, and because a linear regulator has no switching noise to worry about
on a first board.

```
J1 (5V in) --> F1 0.5A polyfuse --> D1 SS14 (reverse protection)
   --> C1 10uF + C2 100nF --> U1 AMS1117-3.3 --> C3 22uF + C4 100nF
   --> J2 (3V3 out) + TP1/TP2/TP3
```

| Block | Parts | Rationale |
|---|---|---|
| Input protection | F1, D1 | Polyfuse for fault current; Schottky drop 0.4 V costs headroom, accepted |
| Input bulk | C1 10 uF, C2 100 nF | Regulator stability and transient supply |
| Regulation | U1 AMS1117-3.3 SOT-223 | Fixed 3.3 V, 800 mA rated, cheap and available |
| Output bulk | C3 22 uF, C4 100 nF | Load step response, high-frequency bypass |
| Access | J2, TP1-TP3 | Measure rails without probing pads |

Known design tension (recorded as R-06 in the risk register): AMS1117 is specified for a
tantalum/electrolytic output capacitor with ESR above ~0.1 ohm. A 22 uF ceramic has an ESR in
the milliohms, which can make this regulator oscillate. The trial board keeps the ceramic and
adds a 0.5 ohm series resistor footprint in the C3 branch so the ESR can be raised without a
re-spin if the load-step test shows instability.