/**
 * The flight test page.
 *
 * Not a second demo — the same one, booted with everything that is not the craft
 * switched off. Settings are a module singleton, so writing them here and *then*
 * importing the entry point means `boot()` reads a world with no walkers, no
 * spells, no wake and no figure in it, and every system underneath is the one
 * that will actually ship rather than a copy of it that can drift.
 *
 * That is the whole file. The alternative — a parallel boot sequence — would be
 * a second place for the render order, the warm-up and the post chain to be
 * wrong, and the thing being tuned here is flight feel, not scene assembly.
 */

import { S } from "./core/settings.js";

S.speeder = true;
S.showWalker = false;
S.showSpells = false;
S.showWake = false;
S.showCharacter = false;
// Audible. It was muted while the craft's *look* was being fought over, and the
// engine bed and the cannons are part of what this page exists to judge. Mute
// in the overlay if it gets in the way.
S.audioMuted = false;
// This page is opened to tune the craft, so the tuning panel starts open rather
// than behind a keystroke. Close it with backtick.
S.overlayOpen = true;

// Only after the overrides are in place: `main.js` boots on import.
await import("./main.js");
