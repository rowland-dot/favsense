# Mockup parity — state: transcript

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#transcript`
**Live:** http://192.168.0.157:8790/index.html#note=6a2a81d1000000001702d3de
**Verdict:** DRIFTED
**Severity counts:** CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0

## Structural diff

_No structural drift detected._

## Token diff

| Element / Property | Mockup | Live | Drift | Severity |
|---|---|---|---|---|
| [capture root] height | 573.359px | 629.484px | 9.8% | MEDIUM |

## Geometry diff

| Dimension | Mockup | Live | Severity | Notes |
|---|---|---|---|---|
| anchor position | offsetLeft=449, offsetTop=3737 | offsetLeft=493, offsetTop=85 | HIGH | 3652px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/transcript-mockup.png`
- Live screenshot: `.gstack/parity/transcript-live.png`
- Mockup DOM: `.gstack/parity/transcript-mockup.html`
- Live DOM: `.gstack/parity/transcript-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0
