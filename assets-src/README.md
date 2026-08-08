# Bake inputs

The source `.glb` files the tools in [`../tools/`](../tools/) chew on to
produce the `.bin` files in `public/models/` that the game actually loads.

They live here rather than in `public/` because `public/` **is the deploy**:
anything in it is uploaded and served, and these four are thirty megabytes
that no browser ever asks for. The runtime only ever fetches the baked
`.bin` + `.webp` pairs.

| file | baked into | by |
|---|---|---|
| `snowtrooper.glb`, `snowtrooper_gun.glb`, `snowtrooper_v3.glb` | `public/models/trooper.bin` | `tools/bakeWalker.mjs` |
| `rebel-pilot.glb` | `public/models/pilot.bin` | `tools/bakeWalker.mjs` |

Re-bake with e.g.:

```
node tools/bakeWalker.mjs assets-src/models/rebel-pilot.glb public/models/pilot.bin
```

(check `bakeWalker.mjs`'s own usage line for the current flags — `--static`,
`--height`, clip selection and so on.)
