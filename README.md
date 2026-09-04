# Rainbowhoof 🦄🌈

**A js13kGames 2026 entry** — theme: *Unicorns and Rainbows*. Everything (code, art, music, sound effects) fits in a **13 KB zip**, with zero external assets: every pixel is drawn by code, every sound is synthesized live.

> A tiny unicorn gallops on its own. **Drag to paint a rainbow — then gallop on it.** Chain rainbows mid-air to raise your multiplier, scoop up stardust to refill your ink, and outpace the void.

Play: open `dist/index.html` (or unzip `dist/game.zip` — that's the exact competition build) in any modern browser. Works with mouse or touch.

## How to play

| Action | Input |
|---|---|
| Start / retry | Click, tap, or `Space` |
| Paint a rainbow | **Drag** (mouse or finger) — costs rainbow ink |
| Mute | `M` |
| Restart run | `R` |

- Painted rainbows stay solid for a few seconds, then dissolve.
- Rainbows are momentum physics: dive on a downslope to bank speed, ride the up-slope to launch — or fly off a crest naturally.
- **Catch a rainbow mid-air** (never touching dirt) to build your chain multiplier.
- Stardust ✨ refills ink **and** scores. A star always floats over the middle of a chasm — nature's hint.
- Fall into the void or touch a spike and the run ends.

## Tech notes

- Pure **Canvas 2D**, no engine, no libraries, no images, no audio files.
- Procedural terrain (segmented columns with curvature-based launch physics), parallax sky, squash & stretch animation — all hand-rolled in ~9 KB of source.
- Audio is a tiny self-implemented [ZzFX](https://killedbyapixel.github.io/ZzFX/)-style synthesizer plus a mini MOD-style music renderer; the looping BGM *Rainbow Fields* is note data rendered to an AudioBuffer at runtime.
- Build pipeline: esbuild → Terser → Roadroller → custom ZIP writer, with a hard size gate and a js13k compliance scanner (no external URLs, no `localStorage.clear`, ASCII-only script body).
- `verify/verify.mjs` runs 86 headless assertions (Chromium + Firefox + a zip-extraction round-trip): boot, scoring, ink economy, rainbow riding, air-catch combos, both death types, persistence, mute, real pointer input, frame rate.

## Repository layout

```
src/            game source (ES modules)
  main.js       state machine, input, scoring, debug hooks
  rainbow.js    ink, stroke capture, arc physics, collision
  unicorn.js    momentum physics, combos, squash & stretch
  world.js      procedural terrain, dust, spikes, camera
  render.js     Canvas 2D renderer (title, HUD, world)
  audio.js      SFX recipes + BGM score
  vendor/       zzfx / zzfxm (self-implemented, ZzFX-style)
build.mjs       size-gated build pipeline
verify/         Playwright verification, bot marathon, audio analysis
dist/           competition build (index.html + game.zip)
```

## AI disclosure

This game was developed with AI assistance (code, tuning and tests), directed and accepted by a human developer. The js13kGames 2026 rules do not prohibit AI-assisted entries; we disclose it anyway.

## License

MIT — see [LICENSE](LICENSE).
