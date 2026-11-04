# Warm-Up: cold-oil icon on the instrument cluster

Warm-Up can show a blue oil-can telltale **on the instrument cluster** (and, if you
change the target, the head-up display) while the engine oil is below the "Oil is warm
at" threshold. It turns off as soon as the oil reaches that temperature.

This is off by default. Turn it on in the app's **Settings → "Cold-oil icon on cluster"**,
and pick where it sits with **"Cluster icon position"**.

## How it works

The MGU app platform draws Warm-Up on the head unit only. To put anything on the
instrument cluster, the app draws through **cluster-render**, a separate renderer by
Robert Nisipeanu that composits app layers onto the cluster and HUD on iDrive 7 and 8:

- Repo: <https://github.com/robertnisipeanu/idrive-apps> (`native/cluster-render`).
- Warm-Up connects to its socket (`/dev/shm/cluster-render/render.sock`), creates an
  `image` layer in the `panel` target, uploads the icon as RGBA pixels, and shows or
  hides it as the oil temperature crosses the threshold.
- The client is `kit/runtime/cluster_render.js` — our own small, MIT implementation of
  cluster-render's documented `PROTOCOL.md` (v1). It contains no cluster-render code
  (that project is MPL-2.0); we only speak its wire protocol.
- The icon is drawn with the kit's software `Canvas` (`cluster_badge.js`), so it needs
  no image assets and themes to any colour.

**If cluster-render is not installed, the setting simply does nothing** — the socket
never connects, every call is a quiet no-op, and the rest of Warm-Up is unaffected.

## Requirement: install cluster-render on the car

cluster-render is **not** part of this repository. To use the cluster icon you must have
it on the head unit. The supported way is through the MGU Store:

1. In the MGU Store, add Robert Nisipeanu's repo as a source (it ships `cluster-render`,
   and the Store pulls `mgu-deploy` first).
2. Install `cluster-render` (any app that needs it, e.g. the Waze-on-cluster app, pulls
   it in too).
3. Keep Warm-Up installed; enable the setting.

> This means our fork gains a runtime dependency on that ecosystem. Nothing in Warm-Up's
> own build or install needs cluster-render — the dependency is only required at runtime
> for the cluster icon, and only when the setting is on.

## Open item to validate on the car

A cluster-render layer lives only while its producer (Warm-Up) stays connected. The app
is launched with `backgroundPriority: 200`, so it should keep running — and keep the icon
up — when it is not the foreground screen, but confirm on your own car that the icon
stays shown after you leave the Warm-Up screen while driving with cold oil. If MainApp
suspends the app in the background, the icon would drop until you reopen Warm-Up; the
client reconnects automatically when that happens.

## Tuning

- **Target / position:** defaults to the `panel` target, top-right. The target is set in
  `cluster_badge.js` (`target: 'panel'`); `map` and `hud` are the other iDrive 7 targets.
- **Colour / size:** `ClusterBadge({ color, size })` in `cluster_badge.js` (default
  `#53b0ff`, 128 px).
- **Threshold:** reuses the app's existing "Oil is warm at" setting.
