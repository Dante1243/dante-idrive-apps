# Warm-Up: the turbo / downpipe heat model

Warm-Up's cool-down used to be a timer: "hard driving" (rpm or power over a line) built up
30 s – 3 min that counted down while you drove gently. That badly under-counts the heat a
turbo actually soaks up, and it ignored the single biggest cooling factor — **road speed**.
A hard pull then a crawl home, versus the same pull then a motorway cruise, got the same
countdown, even though the cruise sheds heat many times faster.

It is now a **continuous heat balance**. Every sample, Warm-Up estimates the turbine-housing /
downpipe temperature from how much heat the exhaust is dumping in versus how much is being
rejected right now at the current load **and vehicle speed**, and tells you when it has
cooled below a coking-safe temperature.

## The model (`turbo_thermal.js`)

One lumped node at temperature `T`, integrated each sample (°C/s):

```
load  = boost (bar, gauge) blended with brake-power fraction (torque·rpm / rated kW)
mdot  = rpmFrac · (0.15 + 0.85·load)              exhaust mass-flow proxy
Tgas  = ambient + egtIdle + egtLoad·load + egtEnrich·enrich(load)   gas temp the metal chases
                                                   (enrich = the EGT spike from fuel enrichment > ~80% load)
heat  = kHeat · flow · (Tgas − T)                 IN  — signed: cooler gas after a lift draws heat out
cConv = (kConv0 + kConvV · speed^0.8) · (T − amb)  OUT — forced airflow  ← the road-speed term
cRad  = kRad · ((T/1000)^4 − (amb/1000)^4)         OUT — radiation (speed-independent)
cOil  = kOil · max(0, T − oil)   while running     OUT — oil/water; STOPS at shutdown → heat-soak
dT/dt = heat − cConv − cRad − cOil
```

Qualitatively this gets the things the old timer missed:

- **Load heats continuously and steeply** — sustained part-throttle or a long climb builds heat
  even if it never trips a "hard" line; full-boost enrichment spikes it hard.
- **Speed cools, strongly** — at a standstill cooling collapses to radiation + weak convection
  (the turbo soaks); at speed `cConv` dominates and it sheds fast. The cool-down countdown is a
  real prediction from the current rate, so it reads seconds on the motorway and minutes idling.
- **Shutdown = soak** — oil cooling stops, so a turbo shut off hot stays hot; the model only
  says "OK to switch off" once `T` is below `cokeTemp`.

## Signals it needs

All plain subscriptions (no diagnostics), added to `app.json`:

| input   | interface / field |
|---------|-------------------|
| boost   | `FES.statusSwitchDriveDynamicSport2` → `displayBoostPressure` (×0.01 → bar) |
| ambient | `EnvironmentalInformation.ExteriorTemperature` → `temperatureExterior` (×0.5 −40 → °C) |

plus the rpm / torque / oil / speed Warm-Up already reads. If boost or ambient are missing on a
car, the model falls back to power-only load and the **Ambient (if no outside-temp sensor)**
setting, so it still runs.

## It is a calibrated estimate — and how to re-bake it

There is **no EGT or housing sensor on the bus**, so the absolute temperature is an estimate,
not a measurement. The constants in `K` (top of `turbo_thermal.js`) are a first pass, tuned so
idle / cruise / sustained-load land in believable ranges. What's physically trustworthy is the
*dynamics* — how load and speed move heat in vs out — which is what the cool-down decision uses.

To calibrate on your car: Warm-Up writes one log line every 5 s —

```
turbo <T>C <rate>/min load <0-1.2> in <degC/s> out <degC/s> spd <km/h> boost <bar> amb <degC>
```

Read it at a warm idle, a steady cruise, and right after a pull, and adjust the `K` constants
(then they can be baked in):

- idle / cruise / WOT temps too high or low  → `egtIdle` / `egtLoad` / `egtEnrich`
- cools too fast / slow with speed           → `kConvV` (and `kConv0` for the standstill floor)
- cools too fast / slow while idling          → `kOil`
- glows and holds heat too long when hot     → `kRad`

## Settings

- **Turbo cool-down (heat model)** — master on/off (`cooldown`).
- **Engine peak power** (`ratedKw`) — for the power-fraction part of load. Default 230 kW.
- **Max boost (gauge)** (`boostMax`) — the boost that counts as full load. Default 1.4 bar.
- **Turbo safe-to-switch-off temp** (`cokeTemp`) — below this, oil won't coke on the bearing;
  the "OK to switch off" / countdown pivots on it. Default 300 °C.
- **Ambient (if no outside-temp sensor)** (`ambientC`) — fallback heat-sink temp. Default 20 °C.
