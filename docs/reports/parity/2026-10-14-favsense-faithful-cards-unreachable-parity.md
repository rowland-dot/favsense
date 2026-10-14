# Mockup parity — state: unreachable

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#unreachable`
**Live:** http://192.168.0.157:8790/index.html#note=6a1fd8a2000000003601ff7a
**Verdict:** DRIFTED
**Severity counts:** CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0

## Structural diff

_No structural drift detected._

## Token diff

| Element / Property | Mockup | Live | Drift | Severity |
|---|---|---|---|---|
| [capture root] height | 425.719px | 493.469px | 15.9% | MEDIUM |

## Geometry diff

| Dimension | Mockup | Live | Severity | Notes |
|---|---|---|---|---|
| anchor position | offsetLeft=449, offsetTop=5432 | offsetLeft=493, offsetTop=153 | HIGH | 5279px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/unreachable-mockup.png`
- Live screenshot: `.gstack/parity/unreachable-live.png`
- Mockup DOM: `.gstack/parity/unreachable-mockup.html`
- Live DOM: `.gstack/parity/unreachable-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0
