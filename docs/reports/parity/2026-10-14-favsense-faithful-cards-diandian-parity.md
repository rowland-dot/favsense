# Mockup parity — state: diandian

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#diandian`
**Live:** http://192.168.0.157:8790/index.html#note=6a7dc92600000000250090ff
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
| anchor position | offsetLeft=449, offsetTop=427 | offsetLeft=493, offsetTop=12 | HIGH | 415px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/diandian-mockup.png`
- Live screenshot: `.gstack/parity/diandian-live.png`
- Mockup DOM: `.gstack/parity/diandian-mockup.html`
- Live DOM: `.gstack/parity/diandian-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=1 LOW=0
