# Mockup parity — state: damaged

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#damaged`
**Live:** http://192.168.0.157:8790/index.html#note=6a44938c0000000006021e9e
**Verdict:** DRIFTED
**Severity counts:** CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0

## Structural diff

_No structural drift detected._

## Token diff

| Element / Property | Mockup | Live | Drift | Severity |
|---|---|---|---|---|
| [capture root] height | 874.031px | 776px | 11.2% | MEDIUM |

## Geometry diff

| Dimension | Mockup | Live | Severity | Notes |
|---|---|---|---|---|
| anchor position | offsetLeft=449, offsetTop=1562 | offsetLeft=493, offsetTop=12 | HIGH | 1550px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/damaged-mockup.png`
- Live screenshot: `.gstack/parity/damaged-live.png`
- Mockup DOM: `.gstack/parity/damaged-mockup.html`
- Live DOM: `.gstack/parity/damaged-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0
