# Warm-Up: the turbo and downpipe heat balance

The **Turbo** page works out, every sample and in real units, how much heat the engine is putting
into the exhaust and how much of it the turbo and downpipe are taking on or rejecting right now,
from rpm, torque and road speed.

**It is an estimate, corrected by the car where the car can.** There is no exhaust or housing
temperature sensor, but the DME runs its own thermal model of the exhaust for this exact engine
(it protects the catalyst and turbo with it) and reports its catalyst temperature. Warm-Up reads
that live (below) and uses it to correct its gas temperature. Underneath, the constants are fitted
to published tests of gasoline turbos, and `kit/tools/test_turbo_thermal.js` holds those
measurements and fails if the model drifts off them. None of those tests was on a B48.

## The DME's own figures

`dme_exhaust.js` asks the engine unit (0x12) about once a second while the engine runs, read-only
through `kit/readonly-diag.js`, the same values Live Data shows:

| Value | Asked as | Scaling |
|---|---|---|
| Catalyst temperature, bank 1 sensor 1 | OBD-II PID 3C, else UDS F43C | 0.1 C, -40 |
| Exhaust after the catalyst (model) | UDS 5896, else 582F | signed, 0.1 K |

The model carries its own catalyst brick, which the gas flows through and follows: slowly at
idle, in seconds at full flow. Where the DME's catalyst figure and ours differ, the difference is
added to the gas temperature, learned separately for five bands of exhaust flow (idle to full
load), and slower than the brick itself responds so it cannot swing. One correction moves the
gas, the turbine housing, its hot spot and the downpipe together. Below about 8 g/s (idle) the
brick is too slow to compare, so idle is not learned. What it has learned is kept in
`dme_learned.json` in the app's data folder: it describes the engine and its tune, not the drive.

The Turbo page says which applies: EXHAUST GAS (DME-CORRECTED) while it learns, (ESTIMATE) before
the DME has answered, (DME SILENT) if it never does (then it asks only every 30 s). The downpipe
bar shows the DME's catalyst figure beside it when there is one.

What the DME cannot tell it: how much air reaches the turbo and downpipe. That depends on the
active grille shutters and the speed, and nothing on the bus says how open they are. It matters
most to the downpipe at a cruise: between shutters shut and wide open, 110 km/h gives anything
from about 560 C to 260 C on the downpipe. At full throttle gas and radiation dominate and it
matters far less.

## What it tracks

Three lumps of metal, each with its own heat balance (`turbo_thermal.js`):

| Lump | Fed by | Cooled by |
|---|---|---|
| Turbine housing | the exhaust gas | radiation first, then air, a little conduction to the bearing housing |
| Downpipe and first catalyst brick | the gas leaving the turbine, plus the catalyst's own heat | radiation and the air under the car |
| Bearing housing | conduction from the turbine housing | coolant and oil, until the engine stops |

On top of those, the housing's **hot spot**: the few millimetres of wall where the gas turns into
the volute, which is what glows first. It is tracked separately because it follows the gas in
seconds, while the 9 kg housing as a whole takes minutes. It is fed by the gas (growing with
flow^0.8), radiates one face, and leaks heat into the thick body around it. It is for display only;
the housing lump still carries the heat, so the cool-down advice does not change. The Turbo page's
top bar shows the housing, which is what a thermometer on its outside reads (a cast wall that thick
is within about 10 C through), with the hottest spot inside beside it. It says GLOWING once the hot
spot passes 700 C: 525 C (the Draper point) is a faint glow only in total darkness and 600-650 C a dull
red at night, so 600 C called a plain cruise "glowing", which no turbo does.

The same goes for the **downpipe**: the heavy lump above includes the catalyst brick, but the
pipe from the turbine outlet into it is 1.5 mm stainless and follows the gas in seconds. The Turbo
page's lower bar is that thin pipe, and says GLOWING above 600 C. On a pull it gets there in about
13 s from a cruise; at a steady 110 km/h it stays well below.

The chain from the signals:

1. **Fuel power** from a Willans line: torque times rpm, plus friction and pumping, over the engine's
   efficiency. Checked against real figures: about 0.9 l/h at idle, 7.2 l/100 km at 110 km/h, about
   260 g/s of exhaust at 225 kW.
2. **Exhaust flow** from the fuel at lambda 1. **Gas temperature** from a map of flow against turbine
   inlet temperature, which tops out near the 950 C limit. With no fuel going in (overrun) the gas
   is warm air instead, which is why lifting off cools a hot turbo fastest of all.
3. **Heat into the metal** by convection, growing with flow. **Heat out** by radiation (emissivity
   0.92, measured), air (growing with road speed) and coolant.

## The data it is fitted to

| Source | What was measured | The model gives |
|---|---|---|
| [M] Savaripour et al., Clean Technologies 2022, 1.7 L gasoline | engine-off cool-down from full load: 683 C to 418 C in 450 s | within 9 C rms, 23 C at worst |
| [M] | warm-up at 2000 rpm, 28 Nm from 8 C | within 29 C rms, 404 C at 820 s against 450 C measured |
| [M] | full load: wall 643-722 C on average, 839 C at its hottest | 729 C, hot spot 838 C |
| The owner's G20 330i, stage 1 | the turbo visibly glowing in under 30 s of full throttle | hot spot past 700 C in about 9 s |
| The same car | the downpipe glowing too | thin pipe past 700 C in about 34 s |
| The same car | about 320 C on an IR thermometer on the outside of the housing, a minute or two after normal driving | 361 C after a minute, 345 C after two (an IR gun set for paint reads oxidised steel 25-45 C low) |
| Owner reports, turbo petrol engines | 700-800 C turbine inlet gas at a closed-loop cruise | never above 790-830 C at any cruise up to 130 km/h, whatever the DME's catalyst figure; never glowing |
| [M] | bearing housing at full load: 122-155 C | 131 C |
| [A] Aghaali, KTH 2012, 2 L GDI | 625 C gas holds a 419 C wall | 426 C |
| [A] | 848 C gas holds a 617 C wall | 613 C |
| [H] A heat-soak test | bearing housing +60 C after shutdown, to 220 C | +48 C, to 208 C |

Turbine inlet temperatures come from [S] Storm, Linkoping/Volvo 2017 (427-877 C over 1000-4000 rpm,
15-135 Nm) as well as [A] and [M].

Fitted, not measured on this car: the split of the housing's thermal mass and area (so **the kW
figures carry more doubt than the temperatures**), how much the heat shield and engine bay hold
radiation back (`bayView`), how much air reaches the turbo at speed (`airHv`), and everything about
the downpipe, which no paper here measured: its constants are worked out from size and material.

## What it shows on a B48

Warm, 20 C outside, steady state. The hard rows assume about 225 kW; a stock 330i makes about 190 kW, so it reads somewhat lower there:

| | Gas | Housing | Downpipe | Exhaust carries |
|---|---|---|---|---|
| Idle, parked | 380 C | 269 C | 182 C | 1 kW |
| 60 km/h | 613 C | 421 C | 255 C | 8 kW |
| 110 km/h | 739 C | 519 C | 359 C | 22 kW |
| 130 km/h | 832 C | 593 C | 456 C | 39 kW |
| 160 km/h | 883 C | 651 C | 551 C | 74 kW |
| Hard climb | 924 C | 727 C | 705 C | 152 kW |
| Full throttle, held | 945 C | 754 C | 732 C | 283 kW |

**On the road, not on a bench.** The published measurements come from test benches: still air, a fan
at most. In the car, air comes through the grille and the bay (`airRam`, from 20 km/h up), and that
was fitted to the owner's own reading above: without it the model had the housing at about 430 C a
minute after normal driving. At a 110 km/h cruise the housing now sits around 390-440 C and the gas
around 750 C. Overrun cools fastest, then low load.

**Switching off: the wheel, not just the housing.** The cool-down advice used to watch only the bearing
soak, which comes from the 9 kg housing. One hard pull hardly moves that, so it said "OK to switch off"
straight after a pull. The turbine wheel and shaft (`Tw`: ~170 J/K of nickel alloy and steel, the gas
over every blade, ~4 s to follow it at full flow) are what a pull heats, and the shaft runs into the
bearing. Switched off then, that heat goes into a bearing with no oil moving. Now:

- the wheel's heat goes into the bearing in the soak (`wToB`), and
- switching off waits until the wheel is back under `wheelOff` (500 C), which idling at ~400 C gas does.

That gives 0 s of idle after town driving, about 25 s after a motorway cruise, about 55 s after one hard
pull and about 85 s after five minutes flat out, against the "about a minute after heavy load" in owner's
manuals (Kia, Hyundai) and the usual 30-60 s. While driving faster than 20 km/h the wheel does not raise
the cool-down screen: it only matters once you stop. The Turbo page shows the wheel beside the housing.

**The DME's catalyst figure cannot make a cruise hot.** The catalyst burns what is left of CO, H2 and
HC in the gas, about 3 % of the fuel's energy, so it runs well above the gas reaching it. Learning
from it once taught the model gas over 900 C at a 110 km/h cruise; the gas now has a ceiling for each
flow (`egtMax`: about 790 C at a cruise, 1000 C at full load).

**A pull lights up the hot spot long before it soaks the housing.** From a 2000 rpm cruise, a full
throttle pull puts about 55 kW into the turbo and downpipe. The hot spot goes from about 520 C to 650 C in
5 s and 800 C in 20 s, which is the glow you can see at night; the housing average moves only about
16 C in the first 5 s and about 80 C in 30 s. Lift off and the hot spot is back near the average within a
minute (overrun cools it fastest), while the housing as a whole takes many minutes. So
"glowing" says the gas is hot, not that the turbo is soaked: soak is what the cool-down advice watches.

For scale: at full throttle a 330i burns about 600 kW of fuel. About a third reaches the crank,
about 40% (some 240 kW) leaves as hot gas, the rest goes to the coolant and oil. The metal takes
only a slice of the gas's share; most of it goes out of the tailpipe.

## Cool-down

Housing temperature is the wrong thing to wait on: a housing takes many minutes to get below 300 C,
at idle it may never go much lower, and it is not what cooks oil. What does is the bearing housing
after the water and oil stop, so "safe to switch off" asks where the bearing housing would **peak**
if you stopped now, looking ahead with the model.

- The limit is the setting **Cool down until bearing soak is under** (default 180 C). It is a
  judgement, not a published figure: I found no hard coking temperature, only that [H] reached 220 C.
- It takes no credit for BMW's electric turbo coolant pump, which [H] suggests cuts the soak to
  about 10 C. That is the safe side: it still holds if the pump has failed, which they do. So
  the figure is a worst case, and with a healthy pump a hot stop is kinder than it looks here.
- The time shown is how long until that peak is under the limit, at idle and at what you are doing now.

After six hard minutes that is about 90 s idling, and 135 s at a 110 km/h cruise.

## Limits

- It starts from coolant temperature, so after a stop short enough to leave the turbo hot but long
  enough for the head unit to sleep, it reads low for a few minutes.
- Torque is what the DME reports. A tune that makes more power than the DME believes reads low;
  the catalyst correction above takes up some of that, since the gas really is hotter.
- It does not know about catalyst heating after a cold start, or anything else that changes the
  spark timing at a given load.

## Boost and ambient

Both are plain signals, but neither is load-bearing. Torque and rpm give the fuel power directly,
so boost only refines the temperature drop across the turbine, and only once it has been seen to
move: car_vitals treats this field as doubtful for the same reason, as some cars never fill it.
Without outside temperature it uses the **Ambient** setting.

## Checking it yourself

Warm-Up logs one line every 5 s: `turbo gas .. housing .. hot spot .. downpipe .. pipe .. cat ..
dme .. (state, learned ..) bearing .. C, exhaust .. in .. out .. kW, soak .., rpm .. Nm .. kmh ..
boost .. amb ..`. `cat` against `dme` is the model's catalyst against the DME's, and `learned` the
correction per flow band. The easy check is an infrared thermometer
on the turbine housing right after parking, set to emissivity 0.92, compared with the Turbo page. The
constants are all in `K` at the top of `turbo_thermal.js`. The glow is a second check you can do by
eye at night: the page should say GLOWING when you can see it, and stop when you can't. The hot
spot's constants (`skin*`) rest on one measured point and the glow, so they are the least certain here.

## Settings

- **Turbo cool-down advice** (`cooldown`): on or off.
- **Cool down until bearing soak is under** (`soakLimit`): see above.
- **Engine size** (`engineL`): 2.0 L for the B48. Scales the flows and the metal.
- **Ambient (if no outside-temp sensor)** (`ambientC`).
