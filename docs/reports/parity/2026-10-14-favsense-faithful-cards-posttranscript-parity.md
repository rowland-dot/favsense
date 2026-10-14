# Mockup parity — state: posttranscript

**Mockup:** `docs/designs/2026-10-14-card-design-rewrite.html#posttranscript`
**Live:** http://192.168.0.157:8790/index.html#note=6a29439c000000002202cf7d
**Verdict:** DRIFTED
**Severity counts:** CRITICAL=0 HIGH=1 MEDIUM=0 LOW=1

## Structural diff

_No structural drift detected._

## Token diff

| Element / Property | Mockup | Live | Drift | Severity |
|---|---|---|---|---|
| [capture root] height | 792.844px | 776px | 2.1% | LOW |

## Geometry diff

| Dimension | Mockup | Live | Severity | Notes |
|---|---|---|---|---|
| anchor position | offsetLeft=449, offsetTop=4475 | offsetLeft=493, offsetTop=12 | HIGH | 4463px drift relative to positioned ancestor; HIGH default per spec § 3.7 (pass --strict-geometry to escalate to CRITICAL). |

## Evidence

- Mockup screenshot: `.gstack/parity/posttranscript-mockup.png`
- Live screenshot: `.gstack/parity/posttranscript-live.png`
- Mockup DOM: `.gstack/parity/posttranscript-mockup.html`
- Live DOM: `.gstack/parity/posttranscript-live.html`

## Severity counts

CRITICAL=0 HIGH=1 MEDIUM=0 LOW=1
