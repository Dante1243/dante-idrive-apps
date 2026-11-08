# Warm-Up: oil telltale on the instrument cluster

Warm-Up can show an oil telltale **on the instrument cluster** (iDrive 7) that follows engine oil
temperature:

- **cold** icon (blue) while oil is below the **"Oil is warm at"** threshold
- **nothing** in the healthy band
- **hot** icon (amber) at/above the **"Oil hot icon at"** threshold (default 110 °C)

Only one shows at a time, by default just right of the ambient-temperature readout: **x = 1670,
y = 620, 90 × 90** in the panel's 1920 × 720 coordinates. It is driven by real oil data only (never
the demo), and off by default: turn it on with **Settings → "Oil icon on cluster"**.

## How it works

The MGU app platform draws Warm-Up on the head unit only. To put anything on the instrument cluster,
the app draws through **cluster-render**, a separate renderer by Robert Nisipeanu
(<https://github.com/robertnisipeanu/idrive-apps>, `native/cluster-render`).

- The KOMBI is its own computer with its own renderer. The head unit sends it scenes, and it shows
  each one in a numbered **slot**. The slot is the placement: the protocol has no position or size.
- Warm-Up connects to cluster-render's socket (`/dev/shm/cluster-render/render.sock`), makes an
  `image` layer in the `panel` target and swaps its pixels as the oil temperature crosses the
  thresholds.
- Client: `kit/runtime/cluster_render.js`, our own MIT implementation of the documented
  `PROTOCOL.md` (v1). No cluster-render code is copied (its client is MPL-2.0, its service GPL-3.0).
- Icons: your PNGs, embedded as base64 in `apps/warmup/cluster_icons.js`, because `build.py` ships
  only an app dir's `.js` files.

**If cluster-render is not installed, the setting does nothing**: the socket never connects, every
call is a quiet no-op, and the rest of Warm-Up is unaffected.

## Why the icon hides the media widget, and what is being done about it

On this car, with the icon up in `panel`, the media widget goes and its button stops working. The
stock map stays. Take the icon away and the widget comes back.

What is known:

- `panel` is slot 0x203, and its scene id 0x01000400 is also BMW's speech dialog.
- cluster-render takes nothing here: `panel` has `take_over_stock` 0 unless Slot Lab kept a slot,
  and without it even a contending layer only waits for the slot. Whatever hides the widget is the
  KOMBI's own doing.
- The KOMBI has groups of slots that switch each other off. An F40 owner found on its HUD that a
  scene in 0x371 makes the KOMBI disable 0x350-0x352 and BMW's guidance goes, while a scene in 0x351
  sits beside that guidance with nothing lost
  ([issue 85](https://github.com/robertnisipeanu/idrive-apps/issues/85)). On the HUD, overlays that
  keep BMW's speed and limit are working on real cars.

What is not known: whether the widget is a head-unit scene or drawn by the KOMBI, and which slots
this car has. That is what the **Cluster** page is for. An older version of this file said no
overlay was possible on iDrive 7. Nothing ever established that.

### Keeping the widget: "Cluster icon stays"

Until a better slot turns up, **10 seconds** (the default) shows the icon when its state changes,
then lets the widget back; hot oil comes back every 5 minutes. **All the time** is the old behaviour.
**"Cluster icon shows for"** (`clusterShow`) still limits it to cold, hot or both.

### Test icon: no install needed

On the **Cluster** page, with music playing so the widget is up, press **Test icon**. The icon shows
for 7 seconds whatever the oil is doing, and the page reports which stock slots changed.

- **A stock slot changed**: the widget is head-unit content in that slot, and the name tells you which.
- **No stock slot changed**: the KOMBI looks to be hiding it by itself, which would rule out capturing it
  from the head unit, but not moving the icon to another slot.

The page lists the slots from the `dcsm: slot ...` lines of cluster-render's log, if an app can read
that on your unit. The file is world-readable, but that has not been tried on a car.

### Slot Lab: trying other slots from the car

Moving `panel` takes a change to cluster-render's settings and a restart of it, which an app cannot
do. **Cluster Slot Lab** is a small optional tool in this repo (`tools/dante-slotlab`) that does just
that. Install it from the Store under this source, then restart the head unit once: a new service
only starts at the next boot.

Parked, on the **Cluster** page:

1. **Next slot** moves the icon to the next thing to try. First the same slot with a scene id that
   is not the speech dialog's, then a pop-up class, then every slot the KOMBI reports free.
2. A see-through grid covers the scene: columns A-H, rows 1-3, each cell 240 px, so A1 starts at
   x 0, y 0 and H3 ends at 1920, 720. Look at the cluster. Is any of the grid there, which cells, and
   is the widget still up? A photo of it is enough to work out where a slot sits.
3. **Keep this** makes it stick and sets the icon to stay on. **Next slot** moves on. Going round the
   whole list comes back to stock, and **Stock** does that at any time.

Then set **Cluster icon X / Y** to land in the cells you saw. On the F40's HUD a small slot showed
only the bottom left of a bigger scene, so expect that here: the spot beside the ambient temperature
may be out of reach from another slot.

Safety:

- **Only at a standstill.** A trial ends the moment the car moves. Cluster-render notes that a mapping
  the KOMBI cannot take can make it restart the cluster and the HUD, which you do not want on the road.
  That was seen with other scene ids, and the lab only uses the three cluster-render allows, but
  these slots are untested on this car.
- **Every trial reverts by itself** after 2 minutes unless kept alive by the app, and at the next
  head-unit start whatever happens. Only **Keep this** lasts.
- It only offers slots the KOMBI reports free, and a trial never takes one from stock content.
- It touches only its own block in `cluster-render.local.conf`, and takes it out when removed.
- Each trial restarts cluster-render, so anything else drawing through it (the Waze map) blinks.

### A kept slot takes over, so the icon comes back

A slot that looks free when you try it often is not free for good. On a G20 330i, 0x105 is where the
cluster shows its optional M badge, and the KOMBI never takes a slot from content it is showing: a
scene sent there is parked out of sight until the slot is free. So once the icon hid (oil warm, or
the icon switched off) and the M badge was back, the icon could not show there again until the head
unit restarted. That is why switching it off and on again left it gone.

From Slot Lab 1.1.0 a kept slot is written with `panel_take_over_stock = 1`, and from Warm-Up 1.11.1
the icon's layer contends. Together, cluster-render moves the stock content aside when the icon
wants the slot, and the KOMBI puts it back when the icon goes: the M badge disappears while the icon
shows and returns after it. A slot kept with 1.0.0 is upgraded the next time the tool starts (an
update from the Store restarts it), with one restart of cluster-render.

Whatever the stock HMI shows in that slot gives way to the icon while it shows. On this car that is
the M badge; if navigation uses the same slot for its turn box, that would hide too, then come back.
The test card of a trial never contends.

## Changing the artwork or position

- **Art:** replace `oil-cold.png` / `oil-hot.png` in `apps/warmup/`, then regenerate the embedded
  module (any machine with `base64`):

  ```sh
  cd apps/warmup
  { echo "'use strict';"; printf 'module.exports = {\n  cold: "'; base64 -w0 oil-cold.png; \
    printf '",\n  hot: "'; base64 -w0 oil-hot.png; printf '"\n};\n'; } > cluster_icons.js
  ```

- **Position / size:** live-tunable on the car via the settings **Cluster icon X / Y / size**. Dial it
  in, then bake the chosen values as the `default`s of `clusterX` / `clusterY` / `clusterSize` in
  `app.json`.
- **Thresholds:** cold uses the existing "Oil is warm at" setting; hot uses "Oil hot icon at"
  (`hotOil`, default 110 °C).

## Requirement: install cluster-render on the car

cluster-render is **not** part of this repository. Through the MGU Store, add Robert Nisipeanu's repo
as a source (it ships `cluster-render`; the Store pulls `mgu-deploy` first) and install it. Nothing in
Warm-Up's own build needs it; the dependency is only at runtime, and only when the icon is on.

The app is launched with `backgroundPriority: 200`, and the icon has been seen to stay up with
another app open.
