**▶ Fly it now: [battleofhoth.app](https://www.battleofhoth.app/)**

![A T-47 snowspeeder banking low over the dunes, two AT-ATs on the horizon](docs/header.png)

# Battle of Hoth Simulator

A real-time, flyable recreation of the **Battle of Hoth** — the opening battle
of *The Empire Strikes Back*. You are in the cockpit of a T-47 airspeeder,
skimming metres over procedural snow while AT-AT walkers advance across the
field, Imperial Star Destroyers hang on station high overhead, and an AI
wingman runs passes beside you.

## The battle

Hoth is the Empire's answer to the destruction of the Death Star: the Rebel
Alliance found hiding on a frozen backwater, and General Veers' walkers landed
beyond the energy shield to take Echo Base the slow, unstoppable way — on
foot. The Rebels' snowspeeders were never going to kill an AT-AT with
blasters; the point of every pass was time — time for the transports to get
out. That is the scene this simulator lives in: the white field, the low sun,
the walkers coming on regardless, and a speeder that is faster than
everything and stronger than nothing.

## What you can do in it

**Fly the T-47.** Repulsorlift flight that hugs the terrain — thrust,
brake and reverse, a boost that opens the field of view and the wind with
it, and a three-rung climb ladder from a deck ride that carves a trench in
the snow up to a clean cruise above the fight. The craft carries momentum:
it banks into its turns, drifts through hard ones, and the camera lags the
way a chase plane would.

**Shoot.** Twin cannons whose bolts are live-tunable — colour, width,
length, speed, range, convergence — and which crater the snow wherever they
land. Bolts that hit near the infantry send them diving; bolts that land on
the armour blossom into raymarched fireballs.

**Hit things, and be hit.** Every machine carries real collision capsules —
four legs that stride with the drawn legs, a hull, a head — and the craft is
swept against them, so nothing tunnels through anything at any speed. What
happens on contact comes from relative velocity, mass, impact angle and
where on the hull you struck it: a graze scrapes and throws snow, a solid
hit deflects and spins you with the controls scrambled, and a hard one
bursts on the airframe and starts a fire you fly home with. An AT-AT is
immovable and answers with a stumble. You can still thread between its legs
at speed — that shot is the whole point of a snowspeeder.

**Fight alongside a flight of three.** AI wingmen fly a full strafing loop —
swing wide, line up, hold the run with the guns open, then break hard past
the legs — with lead pursuit, a lateral-acceleration turn budget, and enough
sense to dodge the machines. One of them specialises in the infantry. They
take damage in stages: smoke, then fire, then a five-and-a-half second death
that is choreographed onto its own crash recording — down at four seconds, a
skip off the snow, and the final impact at five and a half. The wreck stays
where it fell, burning for half a minute and slowly frosting white, with the
pilot's body thrown clear beside it. Only ever one at a time.

**Watch a battle that runs itself.** AT-ATs march in formation on a latched
bearing, never crossing each other and never turning to chase you. AT-STs
keep their distance behind them, each with a squad of snowtroopers holding
station at its heels — troopers who flinch, dive, and die when the fire gets
close. Everything shoots back. Get close enough and the walkers' viewport
slits glow red with crew silhouettes crossing the glass.

**Leave a mark.** The snow is deformable and it remembers: every trench your
deck ride cuts, every crater a bolt digs, every furrow a crashing ship
ploughs. Above it all, Star Destroyers hang on station in the sky.

**Tune all of it live.** The overlay (backtick) exposes several hundred
settings — lighting, snow, the speeder's look and feel, jet plume placement
with a debug view that paints its footprint, collision thresholds and
bounce, walker count and scale, the fleet's station. F2 copies the current
camera, player and herd placement as a pinnable opening shot.

**On a phone, too.** Touch controls with a virtual stick, fire, and climb
buttons, drag to look.

## Running it

```
npm install
npm run dev
```

Controls: **W** thrust · **S** brake / reverse · **A/D** steer ·
**Shift** boost · **E** climb — three rungs, cycling · **Space** fire ·
mouse look · wheel zoom · **`** overlay · **F2** copy the current
camera/player/herd as a pinnable opening shot.

## The engine

**Pure Three.js — Babylon.js is gone entirely.** The original SNOWFLOW ran on
Babylon.js/WebGPU; this is a complete port, and the only runtime dependency
left in `package.json` is `three`. Three.js is used strictly as a WebGL2
rasterizer: every shader is hand-written GLSL (no Three materials, lights,
shadows, or tonemapping), ported line-for-line from the original's WGSL —
clipmap terrain over GPU-baked heightfields, a deformation simulation the
snow remembers with, cascaded shadow maps, a depth prepass feeding
TAA/SSR/DoF, volumetric shafts, AgX tonemapping. The full porting plan,
binding contracts and per-subsystem specs live under [`port/`](port/).
(Babylon still appears in code *comments* — deliberate notes explaining what
each piece replaced.)

## Credits

- **The snow** — the rendering core is a full port of
  [**SNOWFLOW**](https://github.com/Noniv/snowflow_demo) by
  [**Noniv** (Maksymilian Dendura)](https://github.com/Noniv) (MIT), a
  Babylon.js/WebGPU real-time snow tech demo: the procedural terrain, sky,
  snow deformation, shading and post chain all originate in that work,
  translated wholesale to raw WebGL2/GLSL here.
- **The battle** — the Star Wars theme and the Battle of Hoth simulation on
  top of it (the flyable speeder, walkers in combat, the fleet, the wingman
  and the rest) by [Christian Sanz](https://github.com/csanz).
- **AT-AT walker** — baked conversion of
  [*"Imperial AT-AT Walker - Star Wars"* by **Quiznos323**](https://sketchfab.com/3d-models/imperial-at-at-walker-star-wars-7eab3f41da9143d8975b9034e91f8920)
  (Sketchfab), used under
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  That licence is **non-commercial, share-alike**, and covers the baked
  derivative in `public/models/` exactly as it covers the source `.glb`; it
  does not extend to the rest of this repository, but it does mean the demo
  cannot be used commercially while the model is in it.
- **AT-ST walker** — baked conversion of
  [*"Imperial AT-ST Walker - Star Wars"* by **Quiznos323**](https://sketchfab.com/3d-models/imperial-at-st-walker-star-wars-d867c101e5314c33b528cffbe40c0db3)
  (Sketchfab), used under
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) —
  the same licence and the same terms as the AT-AT above, covering the baked
  derivative in `public/models/atst.bin`.
- **T-47 snowspeeder** — fan-made community model, baked to
  `public/models/speeder.bin`. Its original author is not recorded in this
  repository's history; if that's you, open an issue and the credit lands
  here with a link.
- **Imperial-class Star Destroyer** — Sketchfab fan model
  (`star_wars_imperial-class_star_destroyer.glb`), decimated ~28× by
  grid-clustering (`tools/bakeDestroyer.mjs`) into `public/models/destroyer.bin`.
  Same note: author link welcome.

*Star Wars*, AT-AT, the T-47 and all related marks and designs are the
property of Lucasfilm Ltd. This is a non-commercial fan-made tech demo, not
affiliated with or endorsed by Lucasfilm.
