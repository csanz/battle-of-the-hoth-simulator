# Battle of Hoth Simulator

Source: <https://github.com/csanz/battle-of-the-hoth-simulator>

A real-time Battle of Hoth simulation: procedural snow, a flyable T-47
airspeeder, AT-AT walkers on the horizon and the Imperial fleet on station
overhead. Three.js / WebGL2, every shader raw GLSL — a full port of the
original Babylon.js/WebGPU SNOWFLOW demo (see `port/` for the porting plan,
contracts and per-subsystem specs).

```
npm install
npm run dev        # main demo
# /jet.html        # craft tuning page (overlay pre-opened)
```

Controls: **W** thrust · **S** brake / reverse · **A/D** steer ·
**Shift** boost · **E** climb / descend · **Space** fire · mouse look ·
wheel zoom · **`** tuning overlay.

## Model credits

- **AT-AT walker** — [“Imperial AT-AT Walker (Star Wars)” by Quiznos323](https://sketchfab.com/3d-models/imperial-at-at-walker-star-wars-7eab3f41da9143d8975b9034e91f8920),
  licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  Baked to `public/models/walker.bin` + WebP layers by `tools/bakeWalker.mjs`.
- **T-47 snowspeeder** — game-rip mesh baked to `public/models/speeder.bin`.
- **Imperial-class Star Destroyer** — Sketchfab rip
  (`star_wars_imperial-class_star_destroyer.glb`), decimated ~28× and baked to
  `public/models/destroyer.bin` by `tools/bakeDestroyer.mjs`.

Star Wars and all related marks are the property of Lucasfilm Ltd. This is a
non-commercial fan-made tech demo.
