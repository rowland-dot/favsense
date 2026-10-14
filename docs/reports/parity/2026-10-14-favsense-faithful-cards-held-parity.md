# Mockup parity — state: held

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#held`
**Live:** http://192.168.0.157:8790/index.html#note=6ab3dfdc00000000140023f9
**Verdict:** DRIFTED
**Severity counts:** CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0

## Structural diff

_No structural drift detected._

## Token diff

| Element / Property | Mockup | Live | Drift | Severity |
|---|---|---|---|---|
| [capture root] height | 949.125px | 776px | 18.2% | MEDIUM |

## Geometry diff

| Dimension | Mockup | Live | Severity | Notes |
|---|---|---|---|---|
| anchor position | offsetLeft=449, offsetTop=2601 | offsetLeft=493, offsetTop=12 | HIGH | 2589px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/held-mockup.png`
- Live screenshot: `.gstack/parity/held-live.png`
- Mockup DOM: `.gstack/parity/held-mockup.html`
- Live DOM: `.gstack/parity/held-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0
