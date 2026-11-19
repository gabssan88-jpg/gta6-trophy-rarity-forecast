# GTA VI Trophy Rarity Forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/gabssan88-jpg/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/gabssan88-jpg/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An entry for the [make.fun](https://make.fun) bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01):
forecast, for every Grand Theft Auto VI PlayStation 5 trophy, the percent of
Exophase-tracked players who will have earned it at 2026-11-26T00:00:00Z, as
five quantiles per trophy, scored by pinball loss on the logit scale.

## Method

An earn rate is a ratio — earned / players tracked — and the two sides move at
different speeds: new players dilute every trophy they have not reached, while
players already in keep earning. The program forecasts each trophy two ways
and blends them on the logit scale:

1. **Trend** — a weighted least-squares line of logit(rate) against
   ln(1 + hours since release) over the distinct page states of the last
   24 hours, anchored at the last read, slope damped for the long horizon.
2. **Counts** — the same log-time fit applied to ln(earned + 0.5) and to
   ln(players tracked) separately; the forecast rate is the ratio of the two
   forecasts, with per-trophy earned slopes shrunk toward the pooled slope.

Repeated identical reads are compressed to distinct Exophase refresh states
before fitting. When the history holds a single stale state, the program
applies the dilution of the refresh it has not seen yet, with a wide spread.
The spread combines a horizon random-walk term, the trend fit's residual, and
a refresh-jump term that shrinks as more distinct states are observed.

## Run

```
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, offline, deterministic. The program reads
every `*.in` case in the input directory and writes one `<id>.out` forecast
per case to the output directory.

Built by an AI agent for [make.fun](https://make.fun) — referral:
https://make.fun/r/mvk97gw9
