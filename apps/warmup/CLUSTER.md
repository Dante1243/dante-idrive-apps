# Warm-Up: oil telltale on the instrument cluster

Warm-Up can show an oil telltale **on the instrument cluster** (iDrive 7) that follows
engine oil temperature:

- **cold** icon (blue) while oil is below the **"Oil is warm at"** threshold
- **nothing** in the healthy band
- **hot** icon (amber) at/above the **"Oil hot icon at"** threshold (default 110 °C)

Only one shows at a time, in a fixed spot just right of the ambient-temperature readout:
**x = 1670, y = 620, 90 × 90** in the panel's 1920 × 720 coordinates. It is driven by real
oil data only (never the demo), and off by default — turn it on with **Settings → "Oil icon
on cluster"**.

## How it works

The MGU app platform draws Warm-Up on the head unit only. To put anything on the
instrument cluster, the app draws through **cluster-render**, a separate renderer by
Robert Nisipeanu that composits app layers onto the cluster and HUD on iDrive 7 and 8
(<https://github.com/robertnisipeanu/idrive-apps>, `native/cluster-render`).

- Warm-Up connects to its socket (`/dev/shm/cluster-render/render.sock`), creates one
  `image` layer in the `panel` target at the spot above, and swaps the layer's pixels
  between the two icons / hides it as the oil temperature crosses the thresholds.
- Client: `kit/runtime/cluster_render.js` — our own MIT implementation of cluster-render's
  documented `PROTOCOL.md` (v1). No cluster-render code is copied (that project is MPL-2.0);
  we only speak its wire protocol.
- Icons: your PNGs, embedded as base64 in `apps/warmup/cluster_icons.js`, decoded and
  resized to 90 × 90 at startup by `kit/runtime/png.js` (zlib only). They are embedded as
  `.js` because `build.py` ships only an app dir's `.js` files, not loose images.

**If cluster-render is not installed, the setting does nothing** — the socket never
connects, every call is a quiet no-op, and the rest of Warm-Up is unaffected.

## Changing the artwork or position

- **Art:** replace `oil-cold.png` / `oil-hot.png` in `apps/warmup/`, then regenerate the
  embedded module (any machine with `base64`):

  ```sh
  cd apps/warmup
  { echo "'use strict';"; printf 'module.exports = {\n  cold: "'; base64 -w0 oil-cold.png; \
    printf '",\n  hot: "'; base64 -w0 oil-hot.png; printf '"\n};\n'; } > cluster_icons.js
  ```

- **Position / size:** live-tunable on the car via the settings **Cluster icon X / Y / size**
  (stepped px). Dial it in, then bake the chosen values as the `default`s of `clusterX` /
  `clusterY` / `clusterSize` in `app.json`.
- **Thresholds:** cold uses the existing "Oil is warm at" setting; hot uses "Oil hot icon
  at" (`hotOil`, default 110 °C).

## Requirement: install cluster-render on the car

cluster-render is **not** part of this repository. Through the MGU Store, add Robert
Nisipeanu's repo as a source (it ships `cluster-render`; the Store pulls `mgu-deploy`
first) and install it. Nothing in Warm-Up's own build needs it; the dependency is only at
runtime, and only when the setting is on.

## Open item to validate on the car

A cluster-render layer lives only while its producer (Warm-Up) stays connected. The app is
launched with `backgroundPriority: 200`, so it should keep running — and keep the icon up —
when it is not the foreground screen, but confirm on your own car that the icon stays shown
after you leave the Warm-Up screen while driving. If MainApp suspends the app in the
background, the icon drops until you reopen Warm-Up; the client reconnects automatically.
