# Porting spec — subsystem `audio-ui`

Source files (read in full, at `snowflow_demo` HEAD of branch `speeder`):

- `src/audio/engine.js` (637 lines) — Web Audio engine + mixer, `AudioEngine`, `LoopVoice`, singleton `audio`
- `src/audio/manifest.js` (204 lines) — `AUDIO_MANIFEST` asset table
- `src/audio/soundscape.js` (490 lines) — `Soundscape`, the game-state-to-sound mapper
- `src/ui/overlay.js` (503 lines) — `Overlay`, the F1 settings/performance panel
- `src/ui/fpsMeter.js` (87 lines) — `createFpsMeter`, the standalone F-key fps readout
- `src/ui/soundButton.js` (112 lines) — `createSoundButton`, the persistent bottom-left mute/unlock button
- `src/ui/touchControls.js` (362 lines) — `createTouchControls`, on-screen stick/buttons for touch devices
- `public/audio/*` — 21 mp3 assets (inventory in §6)

This subsystem is almost entirely renderer-agnostic: it is Web Audio + DOM. **It contains zero WGSL shaders, zero GPU textures, zero render targets.** The only Babylon touch-points are two informational calls on the engine object inside `Overlay.update` (§5). It ports to the Three.js build nearly verbatim; the work is in re-wiring its *inputs* (the cross-subsystem signals listed in §3) and keeping the boot-sequence contract intact.

---

## 1. Purpose & behavior

### 1.1 Audio engine (`src/audio/engine.js`)

One Web Audio graph for the whole demo:

```
one-shot voices ─┐
loop voices ─────┴─► bus gain ("ambience" | "music" | "sfx" | "voice") ─► master gain ─► limiter (DynamicsCompressor) ─► ctx.destination
```

Design rules the file enforces (keep all three in the port):

1. **Nothing decodes at play time.** `load()` runs during boot and fetches+decodes every manifest entry into an `AudioBuffer`. A one-shot fired from the render loop is only `createBufferSource()` + `start()`.
2. **The context is created suspended and only resumed from a user gesture** (`unlock()`), called synchronously *inside* a click handler (Safari requirement — a promise continuation is "a turn too late").
3. **Gain is never assigned, always ramped** (`setTargetAtTime` or explicit linear ramps) to avoid zipper noise from per-frame writes.

Constants:

- `MAX_VOICES = 24` — hard cap on simultaneous one-shots (returns `null` past it).
- `LOOKAHEAD = 0.6` s — how far ahead the overlap-loop scheduler queues segments.
- `SOLO_RELEASE = 0.06` s — fade applied to a voice displaced from its exclusive group.
- `BUS_NAMES = ["ambience", "music", "sfx", "voice"]`.

Graph details:

- `AudioContext({ latencyHint: "interactive" })`; falls back to `webkitAudioContext`; if neither exists it logs `[audio] Web Audio is unavailable; running silent` and every later call no-ops.
- Limiter: `createDynamicsCompressor()` with `threshold=-6`, `knee=6`, `ratio=8`, `attack=0.004`, `release=0.16`, connected to destination.
- `master` GainNode starts at **0** (opened by `unlock()` → `applyMix`).
- Four bus GainNodes at 1.0, each → master. Note the **`voice` bus is driven by `S.sfxVolume`** (there is no separate voice fader).
- On first `_ensureContext()` it subscribes `applyMix()` to settings keys `["audioMuted","masterVolume","ambienceVolume","musicVolume","sfxVolume"]` via `onChange`, and adds a `visibilitychange` listener: hidden tab → `ctx.suspend()`, visible → `ctx.resume()` (only when already unlocked).

`applyMix(smooth = 0.04)`: ramps `master.gain` to `unlocked && !S.audioMuted ? S.masterVolume : 0`; `buses.ambience → S.ambienceVolume`; `buses.music → S.musicVolume`; `buses.sfx → S.sfxVolume`; `buses.voice → S.sfxVolume`. `unlock()` calls it with `smooth = 0.008` for a fast open.

Loading (`load(onProgress?)`):

- Iterates `AUDIO_MANIFEST` keys in parallel (`Promise.all`).
- An entry with `needs: "<settingsKey>"` is **skipped entirely** when `S[needs]` is falsy (not fetched, not decoded, counted as done for progress). In practice: `speederLaser1/2` and `speederJet` skip unless `S.speeder === true`.
- Per-asset progress is streamed via `res.body.getReader()` against `content-length`; download maps to 0..0.85 of that asset's fraction, decode is the flat last 0.15. Reported progress is the mean over all entries, monotonic.
- Fetch tries each URL from `assetCandidates(path)` in order (CDN blob store first, same-origin `public/` second — see §6).
- One asset failing logs `[audio] failed to load '<key>':` and leaves the key absent from `buffers`; every later `play`/`loop` for it silently no-ops. Never fatal.
- Sets `this.loaded = true` at the end. `hasAssets` getter = `buffers.size > 0` (used by main.js to decide whether to show the boot gate at all).

One-shots (`play(key, opts)`):

- Returns `null` (silently, not an error) when: locked, unknown key, buffer missing, voice cap hit, or the key's `minGap` (opts override manifest) has not elapsed since the last start of that key (tracked in `_last[key]` in context time).
- Voice chain: `BufferSource → per-voice Gain → bus`. `playbackRate.value = (opts.rate ?? 1) * (def.rate ?? 1)`; `gain.value = (opts.gain ?? 1) * (def.gain ?? 1)`; `src.start(now + (opts.delay ?? 0))`.
- **Exclusive groups**: `opts.exclusive ?? def.exclusive`; `true` means group = key itself, a string names a shared group. Starting a new voice in a group calls `_releaseSolo(group, now)` on the incumbent: cancel scheduled values, hold current value, linear ramp to 0 over `SOLO_RELEASE`, `src.stop(now + SOLO_RELEASE + 0.005)` in try/catch. The `onended` handler decrements `_voices`, disconnects both nodes, and deletes `_solo[group]` **only if it still points at this source** (a newer voice may have taken the slot).

Loops (`loop(key, opts)` → `LoopVoice`):

- Manifest entry must declare `loop: true` (otherwise warn + return null). The voice is returned **stopped and silent**; caller calls `start()` and rides the gain.
- `LoopVoice` fields: `unity = def.gain ?? 1`, `rate = (opts.rate ?? 1) * (def.rate ?? 1)`, `trim = def.trim ?? 0`, `crossfade = def.crossfade ?? 0`, `segment = max(0.05, buf.duration - trim*2)`, crossfade clamped to `segment * 0.45`. `gainNode.gain.value = (opts.gain ?? 0) * unity` — note the default *opts* gain for a loop is **0**, not 1.
- **Native mode** (`crossfade === 0`): single `BufferSource` with `loop = true`, `loopStart = trim`, `loopEnd = trim + segment`, started at `(now, trim)`. The only mode whose `setRate(r)` works (ramped with `setTargetAtTime(r, now, 0.08)`).
- **Overlap mode** (`crossfade > 0`): segments scheduled back to back with an equal-power-ish crossfade. `start()` sets `_nextAt = now + 0.005`, `_first = true`, calls `_pump()` once, then `setInterval(_pump, 250)` (4 Hz against the 0.6 s lookahead). `_pump` spawns segments while `_nextAt < now + LOOKAHEAD` (guard max 8 per tick). `_spawn(at)`: per-segment gain envelope — first segment ramps 0→1 over 6 ms (click guard, so the bed opens "already there"), later segments ramp 0→1 over `crossfade`; then hold 1 until `at + segment - crossfade`, ramp to 0 at `at + segment`. `src.start(at, trim, segment + 0.02)`, `src.stop(at + segment + 0.01)`. Next segment starts at `at + segment - crossfade`, so the pair sums to roughly constant energy. A suspended context freezes `currentTime`, so the interval naturally stops queueing in hidden tabs.
- `set(to, smooth = 0.09)` — per-frame-safe one-pole approach: `setTargetAtTime(to * unity, now, smooth)`. No-op unless running.
- `fade(to, seconds)` — cancel + hold + `linearRampToValueAtTime(to * unity, now + max(0.01, seconds))`. Used for entrances/exits where arrival matters.
- `stop(fadeSeconds = 0.25)` — fade to 0 first (order matters: `fade` no-ops once `running` is false), clear interval, `src.stop(now + fade + 0.02)` in native mode.
- `AudioEngine.stopAll(fade = 0.4)` stops every registered loop (loops are pushed into `engine._loops`; never removed except by `stopAll` — fine for this demo's lifetime).

Singleton: `export const audio = new AudioEngine();` — one AudioContext per page.

### 1.2 Manifest (`src/audio/manifest.js`)

`AUDIO_MANIFEST: Record<string, AudioAsset>` with `AudioAsset = { url, bus?, gain?, rate?, needs?, loop?, trim?, crossfade?, minGap?, exclusive? }`. The full table (reproduce exactly):

| key | url (store-relative) | bus | gain | loop | trim | crossfade | minGap | exclusive | needs |
|---|---|---|---|---|---|---|---|---|---|
| `ambience` | `audio/ambiance.mp3` | ambience | 1.0 | yes | 0.2 | 2.5 | — | — | — |
| `music` | `audio/imperial.mp3` | music | 1.20 | yes | 0.08 | 4.0 | — | — | — |
| `slide` | `audio/slide-continue.mp3` | sfx | 0.85 | yes (native) | 0.04 | — | — | — | — |
| `turnA` | `audio/slide-turn-1.mp3` | sfx | 0.7 | — | — | — | 0.42 | — | — |
| `turnB` | `audio/slide-turn-2.mp3` | sfx | 0.7 | — | — | — | 0.42 | — | — |
| `excited1`..`excited6` | `audio/excited-1.mp3`..`-6.mp3` | voice | 0.95 | — | — | — | 20 | — | — |
| `spell1` | `audio/effect1.mp3` | sfx | 0.55 | — | — | — | 0.1 | true | — |
| `spell2` | `audio/effect2.mp3` | sfx | 0.55 | — | — | — | 0.1 | true | — |
| `spell3` | `audio/effect3.mp3` | sfx | 0.55 | — | — | — | 0.1 | true | — |
| `spell4` | `audio/effect4.mp3` | sfx | 0.55 | — | — | — | 0.1 | true | — |
| `spell5` | `audio/effect5.mp3` | sfx | 0.55 | — | — | — | 0.1 | true | — |
| `walkerShot` | `audio/at-walker-canon.mp3` | sfx | 0.5 | — | — | — | 0.05 | — | — |
| `speederLaser1` | `audio/airspeeder-laser-1.mp3` | sfx | 0.42 | — | — | — | 0.04 | — | `speeder` |
| `speederLaser2` | `audio/airspeeder-laser-2.mp3` | sfx | 0.42 | — | — | — | 0.04 | — | `speeder` |
| `speederJet` | `audio/delta-jet.mp3` | sfx | 0.9 | yes (native) | 0.06 | — | — | — | `speeder` |
| `spell2Land` | `audio/effect2-landing.mp3` | sfx | 0.7 | — | — | — | 0.12 | — | — |

Notes that are load-bearing:

- `music.gain = 1.20` is a measured EBU R 128 loudness match (bed −16.8 LUFS, track −19.5, +2.7 dB, times the soundscape's 0.88 at-rest bed ride ⇒ 1.20). Keep it, do not "tidy" to 1.0.
- `ambience` is deliberately unity so `S.ambienceVolume` is the single ceiling.
- **`walkerStep` is referenced by the soundscape but has no manifest entry** — footfalls are deliberately silent until a sample is added; `play("walkerStep", …)` no-ops. Preserve this behavior (do not treat as a bug).
- `trim` exists because MP3 decode leaves encoder padding that clicks on native loops; `crossfade > 0` switches an asset to the overlap scheduler.

### 1.3 Soundscape (`src/audio/soundscape.js`)

The only place that decides *when* sounds play. Pure reader of game state: nothing in gameplay imports the mixer; the soundscape polls counters and continuous signals once per frame. Allocation per frame: none.

Constants: `TURN_GATE = 0.4` (|carve| threshold), `TURN_COOLDOWN = 0.5` s, `TURN_SPEED = 0.3` (min speed01), `TURN_KEYS = ["turnA","turnB"]`; `AIR_LAG = 0.15` m (board-to-ground gap that counts as air), `AIR_REARM = 0.07` m, `AIR_SPEED = 0.72`, `EXCITED_COOLDOWN = 8` s, `VOICE_GUARD = 1.4` s; `MUSIC_FADE_IN = 2.5` s, `MUSIC_DUCK = 0.56` (≈ −5 dB); `STEP_AUDIBLE = 380` m, `SHOT_AUDIBLE = 520` m, `SPEED_OF_SOUND = 343` m/s; `EXCITED_KEYS = ["excited1".."excited6"]`.

Constructor `new Soundscape(audio, refs)` where `refs = { controller, spells?, walkers?, speeder? }` (note: `speeder` is read via `refs.speeder ?? null` though it is absent from the JSDoc). Initializes last-seen counters from `spells.castCount` and `spells.ribbon.splashCount`, per-walker `_steps[]` / `_shots[]` arrays, the excited shuffle-bag (`_bag = [0..5]`, `_bagPos = 6` to force a shuffle on first draw), `_lastTurn = -1`, `_lastExcited = -1`.

`start()` — idempotent, requires `audio.unlocked`, called from the boot gate or sound button:

- `ambience = audio.loop("ambience", { gain: 1 })` + `.start()` — opens **at level** (no fade; the 6 ms click guard is the only ramp).
- `music = audio.loop("music", { gain: 0 })` + `.start()`; `_musicIn = 0` — entrance envelope in `update()`.
- `slideLoop = audio.loop("slide", { gain: 0 })` + `.start()` — runs forever, gain-ridden (never restarted → no seam).
- `jet = audio.loop("speederJet", { gain: 0 })` + `.start()` — no-op when the speeder assets were skipped at load.
- Adopts counters again (`castCount`, `splashCount`, `speeder.shotCount`) so events during the gate do not fire retroactively.

`update(dt)` — per frame, after all gameplay updates (last in the frame, before render). Order inside matters (voice triggers before the music duck reads `_voiceGuard`):

1. **Ambience**: `ambience.set(0.88 + 0.12 * c.speed01, 0.5)` — breathes with speed, only ever downward from unity.
2. **Jet**: `flying = S.speeder !== false`; `sp = flying ? min(1, c.speed01) : 0`; `jet.set(flying ? 0.34 + 0.66*sp : 0, 0.25)`; `jet.setRate(0.82 + 0.36*sp)`.
3. **Slide loop**: `rolling = clamp01((c.speed01 - 0.12) / 0.3)`; `amt = (S.speeder !== false) ? 0 : c.surf * rolling`; `slideLoop.set(amt * (0.4 + 0.6*c.speed01))`; `slideLoop.setRate(0.84 + 0.42*c.speed01)` (just under an octave across the range).
4. **Cooldown decay**: `_excitedCooldown -= dt`, `_voiceGuard -= dt` (when > 0).
5. **Air lines**: `lag = c.position.y - c.groundY`. Trigger when `S.speeder === false && c.surf > 0.5 && c.speed01 > AIR_SPEED && lag > AIR_LAG`, edge-triggered via `_airArmed` (armed on launch, re-armed only when `lag < AIR_REARM`). When cooldown and guard are clear: draw from the shuffle bag (`_drawExcited()` — Fisher-Yates refill, first entry swapped if it equals the last played, so no repeat across the bag seam), `audio.play(key, { rate: 0.97 + Math.random()*0.06 })`; on success set `_excitedCooldown = 8`, `_voiceGuard = 1.4`.
6. **Music**: `_musicIn = min(1, _musicIn + dt / 2.5)`; `music.set(_musicIn * (_voiceGuard > 0 ? 0.56 : 1), 0.3)`. Music does not follow speed.
7. **Turn hits**: when `c.surf > 0.5 && |c.carve| > 0.4 && c.speed01 > 0.3 && _turnCooldown <= 0`: pick random of `turnA`/`turnB` but never the same twice running; `audio.play(key, { gain: 0.45 + 0.55*min(1,|carve|), rate: 0.94 + 0.14*c.speed01 })`; `_turnCooldown = 0.5`.
8. **Spell casts**: poll `spells.castCount` vs `_castCount`; on change and `S.showSpells !== false`: `audio.play("spell" + spells.lastCast, { rate: 0.93 + Math.random()*0.14 })`.
9. **Ribbon splash**: poll `spells.ribbon.splashCount`; on change `audio.play("spell2Land", { rate: 0.95 + Math.random()*0.1 })`.
10. **Speeder guns**: poll `speeder.shotCount`; on change alternate `_laser ^= 1` → `audio.play(_laser ? "speederLaser1" : "speederLaser2", { rate: 0.96 + Math.random()*0.08 })` (alternating, not random — the two barrels alternate).
11. **Walkers** (`_walkerSteps()`, skipped when `S.showWalker === false` or no herd): for each of `herd.count` walkers, poll `w.stepCount` and `w.shotCount` against per-index last-seen arrays. First sight of a walker adopts its count without firing (must write back *before* the early-out). Distance `d = hypot(w.position.x - me.x, w.position.z - me.z)` (2D, `me = controller.position`).
    - Steps: skip if `d > 380`; `near = 1 - d/380`; `audio.play("walkerStep", { gain: near*near, rate: 0.93 + (i%2)*0.05 + Math.random()*0.09, delay: min(1.6, d/343) })` — squared distance falloff, plus a real speed-of-sound delay (the cue that sells scale). Currently silent (no manifest entry) but the full path must be ported.
    - Shots: skip if `d > 520`; `near = 1 - d/520`; `audio.play("walkerShot", { gain: 0.25 + 0.75*near*near, rate: 0.94 + Math.random()*0.1, delay: min(1.6, d/343) })`.
    - Tail loop resets `_steps[i]`/`_shots[i]` to `undefined` for indices `>= herd.count` so a herd regrown via the slider adopts fresh counts.

`stop()` — console-only helper: fades out ambience (0.8 s), music (1.2 s), jet (0.4 s), slide (0.2 s), nulls them, `started = false`.

### 1.4 Overlay (`src/ui/overlay.js`)

Settings + performance panel, hidden by default, toggled with F1 or Backquote (bindings live in `core/input.js`, which calls the `onToggleOverlay` hook). Pure DOM: injects a `<style>` blob and builds `#ov`, a fixed 336 px right-edge panel. Contents top to bottom:

1. Header `SNOWFLOW / F1 to close`.
2. Frame graph: a 304×66 `<canvas>` driven by `FrameGraph` from `core/perf.js` (2D context, bars colored by budget band: >16.7 ms red `#e8734f`, >11.1 ms amber `#e8b04f`, else blue `#6fb2e0`; guide lines at 11.1/16.7 ms; eased y-axis; median line on top). Redrawn at 20 Hz (`_graphAcc >= 50` ms).
3. Readout grid (2 columns): `fps`, `1% low`, `median`, `99th`, `gpu ms`, `draws`, `tris`, `spikes`, `res`. Refreshed at 4 Hz (250 ms). Color classes: fps row `bad` < 60, `warn` < 88; 1%-low row `bad` < 60, `warn` < 75; spikes row `warn` when count > 0. GPU shows `—` (not `0.00`) when `stats.gpuMs <= 0` — "an unavailable number and a zero one are not the same claim".
4. "Frame budget" section: one row per key in `systemMs` (created lazily, then only mutated) showing per-system CPU ms — keys written by main.js are `cpu character`, `cpu spells`, `cpu terrain`, `cpu wake+spray`, `cpu audio`, `cpu submit`, `cpu total`.
5. "Camera" debug section, refreshed at 10 Hz (100 ms): eye position (`fmt2` sign-padded 2-decimal, `white-space: pre` so columns don't jitter), yaw°/pitch° (yaw wrapped 0..360 compass, pitch signed), arm length + vertical fov°, player position, speed m/s + facing° (+ `surf N.NN` when `c.surf > 0.01`). Plus a selectable "pose" line — a paste-able console one-liner (`const s=SNOWFLOW;s.character.position.set(...);s.character.facing=...;s.rig.yaw=...;s.rig.pitch=...;s.rig.distance=s.rig.distanceTarget=...;`) and a "copy pose" button (clipboard with console fallback).
6. "Quality" preset buttons: `ultra`, `high`, `balanced` → `applyPreset(name)` then re-sync all widgets; active button highlighted by `S.preset`.
7. One group per `SCHEMA` entry (12 groups, ~70 widgets): `t:"f"` → `<input type=range>` with min/max/step + formatted value span (`fmtNum` decimal places derived from step), `oninput` → `set(k, parseFloat)`; `t:"b"` → custom switch div toggling on click; `t:"e"` → `<select>`, `onchange` → `set(k, value)`. Widgets push `{k, sync}` records; `toggle()` re-syncs all on open so external writes (presets, console) are reflected.

DOM writes are guarded by `_txt(el, s)` which caches the last string on the element (`el._v`) and only touches `textContent` on change.

Public surface: `constructor(refs?: {rig?, character?})`, `attach(refs)` (late-bind), `toggle()`, `update(dtMs, engine)`, `resetSpikes()` (delegates to perf), `visible`, `el`.

### 1.5 FPS meter (`src/ui/fpsMeter.js`)

`createFpsMeter()` → `{ visible, toggle(), update(dtMs), dispose() }`. A tiny fixed top-left pill (`#fpsm`) showing only `NN fps`. Toggled with the F key (hook wired through `initInput`'s `onToggleFps`). Reads `stats.fps` from `core/perf.js` — no second clock. Refresh 250 ms; on `toggle()` the accumulator is pre-loaded (`acc = PERIOD`) so the first visible frame shows a number, not the stale one. Color thresholds identical to the overlay: class `bad` < 60, `warn` < 88; shows `--` when fps ≤ 0. `pointer-events: none; user-select: none`.

### 1.6 Sound button (`src/ui/soundButton.js`)

`createSoundButton(audio, hooks?: { onEnable })` → `{ reveal(), sync(), el }`. Fixed bottom-**left** 34×34 button (`#snd`), hidden (`opacity 0`, no pointer events) until `reveal()` adds `.ready` — called by main.js after the boot screen is done. Inline SVG glyphs (speaker + arcs when audible, speaker + X when not); no image assets.

Click handler (order is deliberate):

- `btn.blur()` first — Space is the slide key and a focused button would re-activate on it.
- If `!audio.unlocked`: call `audio.unlock()` **synchronously in the handler** (Safari), then `set("audioMuted", false)`, then on the promise: if resumed OK fire `hooks.onEnable()` (→ `soundscape.start()`), then `sync()`.
- Else: `set("audioMuted", !S.audioMuted)`; `sync()`.

State lives in `S.audioMuted`, not in the widget; it subscribes `onChange("audioMuted", sync)` so the overlay's Mute toggle keeps the glyph honest. `sync()` computes `audible = audio.unlocked && !S.audioMuted` and sets class `on`, `innerHTML` glyph, `title`/`aria-label` (`"mute"` / `"sound on"`), `aria-pressed`.

### 1.7 Touch controls (`src/ui/touchControls.js`)

`createTouchControls(hooks?: { onToggleOverlay })` → `{ visible, dispose() }`. Hand-rolled twin-stick rig, entirely DOM + Pointer Events, writing into the shared input structs from `core/input.js` (`input`, `touch`). Nothing renders or is interactive until the **first `pointerdown` with `pointerType === "touch"`** anywhere on the page (capture listener on `window`); then `#tc` gets class `on`, `document.body` gets class `touch`, `touch.present = true`, and the `#hint` element (owned by the boot screen HTML) is rewritten to `"stick to move · drag to look · hold slide"`.

Constants: `LOOK_SCALE = 0.0034` rad/px (higher than the mouse's 0.0022), `RADIUS = 62` px stick throw, `DEAD_ZONE = 0.14` (rescaled, not clipped: `scaled = (mag - dz)/(1 - dz)`), `SPRINT_AT = 0.86` deflection, `PINCH_SCALE = 0.004`.

Layout (each control captures its own pointer id → natural multi-touch):

- `.look` — full-screen surface under everything; one finger drags accumulate `input.lookX += dx*LOOK_SCALE`, `input.lookY += dy*LOOK_SCALE`; two fingers are a pinch: `input.zoomDelta -= (spread - prevSpread) * PINCH_SCALE` (look suppressed while pinching; pinch baseline re-taken when a finger lifts back to 2).
- `.stick` — left 48% × 62% region; floating recentre (base+knob jump to the touch point); direction from the *unclamped* delta, throw clamped to RADIUS; writes `touch.x = ux*scaled`, `touch.z = -uy*scaled` (screen down = world back), `touch.active`, `touch.sprint = mag > SPRINT_AT`; release zeroes everything and re-rests the puck at `restX = RADIUS + 34`, `bottom - RADIUS - 46`.
- `slide` button (bottom right 108×62 pill): hold → `touch.surf = true/false`.
- 5 spell buttons stacked above it (46 px circles, bottom `100 + (5-n)*56` px + safe-area inset): press → `input.spellPressed = n` (+ `input.spellHeld2 = true` for n=2), release → `spellHeld2 = false` for n=2.
- gear button (top left): → `hooks.onToggleOverlay()`.

`bindButton` uses `pointerdown`/`pointerup`/`pointercancel` with pointer capture (never `click` — too late for held controls, and synthetic post-touch clicks would double-fire; `click` is preventDefault-ed).

`core/input.js` (owned by another subsystem, but the contract): `pollInput()` rebuilds `input.moveX/moveZ` from keys each frame and the stick **wins while active** (replaces, does not sum); `touch.surf` ORs into the slide/fire trigger; `endFrame()` zeroes `lookX/lookY/zoomDelta/spellPressed` each frame — which is why the touch layer accumulates with `+=`. `window blur` clears the touch struct too.

### 1.8 Boot / frame wiring (from `src/main.js`)

Construction order: `audio.load()` is kicked off before the WebGPU device exists (network overlaps GPU init) and awaited at "loading audio" (progress 0.96). `Overlay` is built with `{ rig, character }`; `createFpsMeter()`; `initInput(canvas, { onToggleOverlay, onToggleFps })`; `createTouchControls({ onToggleOverlay })`; `new Soundscape(audio, { controller: character, spells, walkers, speeder })`; `createSoundButton(audio, { onEnable: () => soundscape.start() })`.

Gate: only if `audio.hasAssets`, `loading.gate(() => { unlocking = audio.unlock(); })` — unlock issued synchronously inside the click/keydown handler; awaited outside; then `soundscape.start()`; `soundButton.sync()`; after `loading.done()`, `soundButton.reveal()`; `setTimeout(() => overlay.resetSpikes(), 800)` (discard warm-up spikes).

Per-frame call order (this subsystem's slots):

```
pollInput() → gameplay updates … → soundscape.update(dt)   // LAST sim step, pure reader
→ scene.render() → mark("cpu audio", …) etc. → stats.gpuMs = …
→ endFrameDraws() → stats.triangles = … → sample(dtMs) → checkSpike(dtMs)
→ overlay.update(dtMs, engine) → fpsMeter.update(dtMs) → endFrame()
```

`soundscape.update` runs after every signal it mixes on (surf blend, carve, speed, counters) has settled. `overlay.update`/`fpsMeter.update` take `dtMs` (milliseconds, clamped ≤ 100 upstream) and run even when `S.freezeTime` is on (they use dtMs, not dt).

Also exposed on `globalThis.SNOWFLOW`: `audio`, `soundscape`, `overlay`, `touchControls` (console debugging; the pose script depends on `SNOWFLOW.character` / `SNOWFLOW.rig`).

---

## 2. Public API

### `src/audio/engine.js`

- `export class AudioEngine`
  - `get hasAssets(): boolean`
  - `async load(onProgress?: (p: number) => void): Promise<void>` — call once at boot, before the gate.
  - `async unlock(): Promise<boolean>` — must be issued synchronously inside a gesture handler.
  - `applyMix(smooth = 0.04): void`
  - `play(key, opts?: { gain?, rate?, delay?, bus?, minGap?, exclusive?: boolean|string }): AudioBufferSourceNode|null`
  - `loop(key, opts?: { gain?, rate?, bus? }): LoopVoice|null`
  - `stopAll(fade = 0.4): void`
  - fields: `ctx`, `master`, `limiter`, `buses`, `buffers: Map<string, AudioBuffer>`, `loaded`, `unlocked`
- `export class LoopVoice` — `start()`, `set(to, smooth = 0.09)`, `fade(to, seconds)`, `setRate(r)` (native mode only), `stop(fadeSeconds = 0.25)`, field `running`
- `export const audio` — the singleton

### `src/audio/manifest.js`

- `export const AUDIO_MANIFEST` (table in §1.2); JSDoc typedef `AudioAsset`.

### `src/audio/soundscape.js`

- `export class Soundscape`
  - `constructor(audio, { controller, spells?, walkers?, speeder? })`
  - `start(): void` — idempotent; requires `audio.unlocked`.
  - `update(dt: number): void` — dt in **seconds**; call once per frame after all gameplay updates.
  - `stop(): void` — console-only.

### `src/ui/overlay.js`

- `export class Overlay`
  - `constructor(refs?: { rig?, character? })`
  - `attach(refs): void`
  - `toggle(): void`
  - `update(dtMs: number, engine): void` — dtMs in **milliseconds**; `engine` only used for `getRenderWidth()/getRenderHeight()`.
  - `resetSpikes(): void`

### `src/ui/fpsMeter.js`

- `export function createFpsMeter(): { visible, toggle(), update(dtMs), dispose() }`

### `src/ui/soundButton.js`

- `export function createSoundButton(audio, hooks?: { onEnable?: () => void }): { reveal(), sync(), el }`

### `src/ui/touchControls.js`

- `export function createTouchControls(hooks?: { onToggleOverlay?: () => void }): { visible, dispose() }`

### Settings keys consumed (exact keys in `src/core/settings.js`)

- Engine mixer: `audioMuted` (bool, default false), `masterVolume` (0.8), `ambienceVolume` (0.34), `musicVolume` (0.34), `sfxVolume` (1.0) — subscribed via `onChange`, plus read every `applyMix`.
- Engine load: `speeder` via manifest `needs` fields (`speederLaser1/2`, `speederJet`).
- Soundscape: `S.speeder` (jet level/slide mute/air-line mute), `S.showSpells` (cast sounds), `S.showWalker` (step/shot sounds).
- Overlay: whole `SCHEMA` array, `S.preset`, `applyPreset("ultra"|"high"|"balanced")`, `set(k, v)`, plus reads of every schema key for widget sync.
- Sound button: `audioMuted` via `set`/`onChange`.
- Settings API shape: `S` (flat mutable object), `SCHEMA` (widget metadata `{group, items:[{k,l,t:"f"|"b"|"e",min,max,step,opts}]}`), `set(k,v)` (notify), `onChange(keys, fn) → unsubscribe`, `applyPreset(name)`, `PRESETS`.

---

## 3. Data flow (cross-subsystem objects; none are GPU resources)

This subsystem exchanges **no textures, render targets, or uniform buffers** with anything. Its interfaces are plain JS objects polled per frame:

Consumed (owner in parentheses):

| Object / field | Owner | Used by | Notes |
|---|---|---|---|
| `controller.speed01` (0..1, normalized to slide top speed) | character/controller | soundscape | ambience/jet/slide levels + rates, gates |
| `controller.surf` (eased slide blend 0..1) | character/controller | soundscape, overlay | slide gate, turn gate, air gate; overlay readout |
| `controller.carve` (eased lateral load, signed) | character/controller | soundscape | turn-hit gain + gate; same signal the wake is shaped from |
| `controller.position` (`{x,y,z}`), `controller.groundY` | character/controller | soundscape, overlay | air detection `position.y - groundY`; walker distances; readouts |
| `controller.speed` (m/s), `controller.facing` (rad) | character/controller | overlay | readouts + pose script |
| `spells.castCount`, `spells.lastCast` (1..5), `spells.ribbon.splashCount` | spells/spellSystem | soundscape | polled counters, edge = change |
| `walkers.count`, `walkers.walkers[i].stepCount`, `.shotCount`, `.position.{x,z}` | walkers/walker (WalkerHerd) | soundscape | polled counters; herd may grow live |
| `speeder.shotCount` | player/speeder | soundscape | polled counter |
| `rig.camera.position`, `rig.yaw`, `rig.pitch`, `rig.distance`, `rig.distanceTarget`, `rig.fov` (rad, vertical) | core/camera (CameraRig) | overlay | readouts + pose script |
| `stats` (fps, fpsLow, median, p99, gpuMs, drawCalls, triangles), `systemMs`, `spikes`, `FrameGraph`, `resetSpikes` | core/perf | overlay, fpsMeter | perf owns the ring buffer; main.js feeds it |
| `engine.getRenderWidth()/getRenderHeight()` | Babylon engine | overlay | the "res" readout — the one Babylon API in the subsystem |
| `input`, `touch` structs; `initInput` hooks `onToggleOverlay`, `onToggleFps` | core/input | touchControls, overlay/fps toggles | touch layer writes `touch.*`, `input.lookX/lookY/zoomDelta/spellPressed/spellHeld2` |
| `assetCandidates(path)` | core/assets | audio engine | CDN-first URL list |
| `loading.gate/done/phase`, `#hint` DOM element | core/loading + index.html | main.js + touchControls | gate gesture = unlock; touch layer rewrites the hint text |
| `S`, `SCHEMA`, `set`, `onChange`, `applyPreset` | core/settings | all of the above | |

Produced for others:

| Object | Producer | Consumers |
|---|---|---|
| Audible output (Web Audio graph) | AudioEngine | the user |
| `touch` struct + `input.lookX/lookY/zoomDelta/spellPressed/spellHeld2` writes | touchControls | `core/input.pollInput` → camera rig, controller, spells |
| Settings writes via `set()` | overlay widgets, sound button | every `onChange` subscriber in the demo (terrain rebuilds, material freezes, resolution scale, etc.) |
| `soundscape.start` as `onEnable` callback | sound button → main.js wiring | soundscape |
| Overlay budget rows | overlay | humans (reads `systemMs`, written by main.js `mark()`) |

Timing/update contract: `soundscape.update(dt)` must run after character/spells/walkers/speeder updates in the same frame; `overlay.update(dtMs, engine)` and `fpsMeter.update(dtMs)` after render + `sample()`/`endFrameDraws()`; `endFrame()` (input) last of all — touch look/zoom accumulators are consumed in the same frame they were written.

---

## 4. Shader inventory

**None.** This subsystem contains no WGSL, no GLSL, no GPU passes. The only drawing it does is the overlay's frame graph, on a plain 2D canvas (`getContext("2d", { alpha: true, desynchronized: true })` — lives in `core/perf.js`'s `FrameGraph`, consumed here). Nothing to translate.

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon usage | Where | Three.js WebGL2 replacement |
|---|---|---|
| `engine.getRenderWidth()`, `engine.getRenderHeight()` | `Overlay.update` "res" readout | `renderer.getDrawingBufferSize(new THREE.Vector2())` (device pixels, matches Babylon's meaning) or `renderer.domElement.width/height`. Change `update(dtMs, engine)` to take the renderer (or a `{width,height}` provider). |
| `stats.gpuMs` fed by `engine.getGPUFrameTimeCounter()` (WebGPU timestamp queries, installed in main.js) | overlay reads `stats.gpuMs` | WebGL2 has no core timestamp query. Options: `EXT_disjoint_timer_query_webgl2` where available (rarely on modern Chrome/all Safari), else leave `stats.gpuMs = 0` — the overlay already renders `—` for 0/unavailable, which is the designed fallback. Do not fake it with frame cadence. |
| `stats.drawCalls` fed by `installDrawCounter` wrapping `engine.drawElementsType`/`drawArraysType` (perf subsystem, but the overlay displays it) | overlay | `renderer.info.render.calls` latched after render (`renderer.info.autoReset` semantics: read after `renderer.render`, or set `autoReset = false` and reset manually at frame end). Same for `renderer.info.render.triangles` if the hand-summed `stats.triangles` is replaced. |
| Everything else | — | Nothing. Web Audio, DOM, Pointer Events, `AudioContext.decodeAudioData`, canvas 2D are platform APIs; the port is copy-through. No coordinate-handedness issues (the soundscape uses distances and heights only; no panner nodes / no HRTF — audio is deliberately non-spatial except distance gain + delay). |

Boot-contract equivalents to preserve in the Three build: kick `audio.load()` before renderer/asset init so the download overlaps; keep the gate → synchronous `unlock()` → `soundscape.start()` sequence; keep `overlay.resetSpikes()` ~800 ms after boot; keep the coarse-pointer preset drop (`applyPreset("balanced")`, `S.resolutionScale = 0.7`) before anything reads sizes.

---

## 6. Assets

All audio is MP3, fetched at runtime — no .bin layouts in this subsystem. Resolution order (from `core/assets.js`): `https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com/<path>` first (public Vercel Blob, `access-control-allow-origin: *` — required for `decodeAudioData` on cross-origin bytes), then same-origin `<path>` (i.e. `public/audio/...`). Override with `VITE_ASSET_BASE` (empty string = local only).

Inventory of `public/audio/` (all present locally; sizes as on disk):

| file | bytes | manifest key(s) |
|---|---|---|
| `ambiance.mp3` | 695,040 | `ambience` |
| `imperial.mp3` | 2,477,372 | `music` |
| `slide-continue.mp3` | 69,120 | `slide` |
| `slide-turn-1.mp3` | 57,600 | `turnA` |
| `slide-turn-2.mp3` | 50,880 | `turnB` |
| `excited-1.mp3` … `excited-6.mp3` | 46,080 / 50,880 / 50,880 / 38,400 / 48,000 / 61,440 | `excited1..6` |
| `effect1.mp3` | 142,080 | `spell1` |
| `effect2.mp3` | 43,200 | `spell2` |
| `effect2-landing.mp3` | 19,200 | `spell2Land` |
| `effect3.mp3` | 93,120 | `spell3` |
| `effect4.mp3` | 120,000 | `spell4` |
| `effect5.mp3` | 238,080 | `spell5` |
| `at-walker-canon.mp3` | 23,040 | `walkerShot` |
| `airspeeder-laser-1.mp3` | 55,680 | `speederLaser1` (needs `speeder`) |
| `airspeeder-laser-2.mp3` | 40,320 | `speederLaser2` (needs `speeder`) |
| `delta-jet.mp3` | 133,440 | `speederJet` (needs `speeder`) |

Every file on disk has a manifest entry and vice versa. There is **no** `walkerStep` sample — intentional (see §1.2). The sound button and touch controls ship no image assets (inline SVG / CSS only).

---

## 7. Porting risks & gotchas (ranked)

1. **Gesture-unlock ordering (Safari).** `audio.unlock()` must be called synchronously inside the click/keydown handler — both `loading.gate(onEnter)` and the sound button do this deliberately, resolving the promise afterwards. If the Three port's boot flow awaits anything between the gesture and `ctx.resume()`, Safari refuses to resume and the demo is permanently silent. Preserve the callback-into-the-handler shape exactly (gate: `onEnter` runs before the promise resolves; button: `unlock()` before `set("audioMuted", false)`, `.then` only for `onEnable`/`sync`).
2. **Frame-order dependency of the soundscape.** It is a pure poller: `soundscape.update(dt)` must run after controller/spells/walkers/speeder updates and it edge-detects counters (`castCount`, `splashCount`, `stepCount`, `shotCount`, herd growth adoption). If the Three port reorders the frame or replaces counters with events, casts get double-fired or dropped, and the "adopt on first sight / after gate" logic (in `start()` and `_walkerSteps`) silently breaks — e.g. a burst of backdated walker steps when the herd slider grows. Port the counter contracts along with the other subsystems.
3. **GPU/draw stats plumbing disappears on WebGL2.** `stats.gpuMs` comes from WebGPU timestamp queries and `stats.drawCalls` from wrapping Babylon's two draw entry points; neither exists in Three. Use `renderer.info` for draws/tris and accept `—` for GPU ms (the overlay already handles 0 as "unavailable") unless `EXT_disjoint_timer_query_webgl2` is wired. Risk is quiet wrongness: leaving the old fields unset renders misleading zeros for draws/tris rather than dashes.
4. **Loop seam fidelity depends on the exact envelope math.** The overlap scheduler's constants (LOOKAHEAD 0.6 s, 250 ms pump, first-segment 6 ms click-guard vs. full-crossfade entrance, `_nextAt = at + segment - crossfade`, `trim` offsets against MP3 encoder padding) and the native loops' `loopStart/loopEnd = trim … trim+segment` are all audible if changed: the wind bed ticks every ~17 s, the music join stops passing as a musical decay, the slide/jet loops click. Also keep the rule that only *native* loops may `setRate` — retuning an overlap schedule walks the joins out of alignment.
5. **Settings store is the nervous system.** The overlay writes through `set()` and half the demo subscribes via `onChange`; the mixer subscribes to five audio keys; manifest `needs` reads `S.speeder` at load time; the coarse-pointer preset drop must happen before construction-time reads. If the Three port re-architects settings (e.g. a different store), every exact key in §2 must survive, including the semantics "`voice` bus is driven by `sfxVolume`" and "`audioMuted` is the single source of truth shared by two widgets".
6. **Touch layer vs. input reconciliation.** `touchControls` writes a *separate* `touch` struct precisely because `pollInput()` rebuilds `input.moveX/moveZ` from keys each frame (a direct write would be erased); look/zoom are `+=` accumulators zeroed in `endFrame()`. Reveal is gated on `pointerType === "touch"` (not `maxTouchPoints`), and every control does its own pointer capture (no `click`). Recreating this on top of a different input module without those two contracts (stick-wins-while-active, per-frame accumulator reset) yields dead sticks or runaway cameras on hybrid laptops.
7. **Minor but real:** `Overlay` and `fpsMeter.update` take **milliseconds** while `Soundscape.update` takes **seconds** — easy to swap when re-wiring the loop; overlay/fps must keep running under `freezeTime` (they use dtMs). The pose script emits `SNOWFLOW.*` console code — keep the `globalThis.SNOWFLOW` handle (with `character`, `rig`) or the copy-pose feature emits dead code. The `#hint` element and `body.touch` CSS hook live in the host page HTML/boot screen, owned outside this subsystem — the Three port's index.html must provide them. `visibilitychange` suspend/resume and the window-`blur` input clear are both required to avoid a droning background tab / stuck controls.
