# Mothball

A 2D, Katamari-style browser game made from Mothbox insect data. You play the
trap's UV light. Roll up a night of insects before dawn. Each level is built
from a real dataset. Every insect is a background-removed photo from the trap,
at its real measured size.

```
bun install
bun dev            # http://localhost:5173
```

Open `?level=<url>` to load a different pack. You can also drop a
`.mothball.zip` onto the page, or use **Load a level pack…** on the menu.

## How it plays

- **← →** roll, **↑ / Space** hop, **↓↓** (double tap) drop through the path you're on. Hops are single: you have to touch the ground again before the next one. Launch ramps add height. A path you drop through leaves you alone until you're clear of it, so rolling along just under it doesn't scoop you back up.
- An insect sticks when its length is under your radius (`T.collectRatio` × core radius). Larger insects are obstacles until you grow.
- The ball grows by a share of each insect's real silhouette area (`T.growth`).
- **The ball gets awkward.** Ground insects stick lying flat where they touched, even on top of other insects. A share of flyers and perchers (`T.headFirst`) hit the lamp head first and stand out like spines. Each stuck insect collides with its whole silhouette, legs and antennae included (traced from the atlas when the pack loads). So a ball full of crane flies tumbles over its own legs, and spines can lever you up onto things.
- **The flood light** (**F** or **Ctrl**, 3 per night) shows everything for 2 s. Flyers scatter, nearby insects take off, and everything jutting out of your ball is shaken off. You roll smoother, but you lose what those insects added.
- A hard hit sends your newest lumps flying off.
- Insects buried under newer ones are painted into a picture of the ball (a render texture) and their sprites dropped. So the ball stays packed all the way in, with the lamp glowing through, without drawing thousands of sprites.
- The camera holds its zoom while you visibly swell, then pulls out in one move, Katamari-style.
- **Flyers** are most of the insects (`T.flyerChance`, by order). When your light reaches them they circle it instead of flying straight in, the way insects keep their back to a light. They dip into reach now and then, and wander off after a while.
- **Perched** insects sit on plant stalks (now and then a big plant) and along the paths. **Ground** insects are spread out; some crawl and they all twitch now and then. Lit insects may take off and join the swarm.
- You can only see what your light reaches.
- The night ends at sunrise. The clock counts down the real time left (`T.nightSeconds`), next to the time of night taken from the insects' capture times.

## How a level is built (`src/levelgen.ts`)

1. **Zones from growth.** The generator simulates rolling up every insect,
   smallest first. Each time the ball would double in radius, a new zone
   starts. So zone *z* holds the insects you grow on between radius R and 2R.
2. **Areas, not a corridor.** Zone 0 is the forest floor, and you start in
   the middle of it. Every later zone is an **area** higher up: a long strip
   of one-way ground, `T.paths.areaLift` × its radius above the area you
   reach it from. It runs off left or right at random from where you arrive,
   so the world is a heap of ever-longer ledges going every which way. Trunks
   hold them up in the background. Each area's terrain is rolling hills,
   half-pipe bowls, launch ramps and flat spots, and it curls up at its far
   end so you don't roll off by accident.
3. **Paths.** Everything above the floor is **one-way**: solid from above,
   open from below (`src/ledges.ts`). You can hop up through a path and land
   on it, roll or fall off any edge, or press ↓ to drop through, but nothing
   can close over the ball.
   - The way into zone *z* is its **connector**, a long ramp that starts at a
     lip hanging over a flat spot in the area below. A bare ball can't hop
     onto it until it has about zone *z*'s radius (`T.paths.lipEase`). The
     gate is purely physical, though: a ball lumpy enough to stand tall on
     its spines, or to lever itself up, can sneak ahead early.
   - Every area has 2–3 **alternative paths**. They start from a lip that is
     either a small hop or needs a bigger ball, climb a little, wander along
     above the area, and end in a drop. Insects are denser up there
     (`T.paths.density`), with bigger ones on the gated paths.
   - **Gaps.** Every higher area has one to three, and some paths have one
     (`T.paths.gaps`). Hop them, or be big enough to roll across (a ball
     about 1.15 × as wide as the gap rolls over: the far edge catches it while
     its centre is still half a radius above it). Otherwise you fall and
     climb back up.
   - Every path stays at least its lip's height above whatever is under it,
     so nothing can be reached from below without the size its lip asks for.
     `src/levelgen.test.ts` checks this on every vertex.
   - The HUD names a gated lip overhead and the size a bare ball needs for it.

   Rapier has no one-way colliders, so a contact filter decides every step
   which of the ball's colliders each path segment holds. The core counts
   once its bottom is within 0.15 r of the surface. A lump counts the same
   way, by its own hull, but only while the core's centre is above the path
   and the lump is over the segment, not beside it. So the ball rolls on its
   lumps up there too, but a spine poking up from below can't hook a path
   and leave the ball hanging. Insects sitting on a path are only solid to a
   ball that's up on it.
4. **Insects.** Flyers hover over each area, some around its paths. Ground
   insects are spread along the surfaces, smallest nearest where you arrive.
   A few long, flat insects from later zones lie in the way as obstacles you
   can hop over.

The floor is solid (convex slabs, not a bare line, so lumps can't poke through
it). It reaches under every area, so a fall always lands somewhere you can
climb back up from. Earlier versions tried a left-to-right corridor with cliff
gates, enclosed tunnels (a ball could grow inside one and get stuck), and
switchback giant plants (ladders, not places to explore). They were replaced
by this layout.

Everything is scaled to the ball's radius: gravity, speed, hop height and the
camera. So the game feels the same at 1.5 mm as at 15 cm. A bare ball hops
onto a lip about 0.9 × its radius up, at every size.

## Making a level pack

In **Mothbot Classify**, open a dataset and click **Export Visualization**,
then **Export game level**. The pack uses the dialog's scope and filters
(nights, taxa, blurriness, error/noise toggles, limit). Insects without a
transparent `_nobg.png` silhouette are left out. The zip is saved to the
package's `04_exports/`.

From a terminal, with Classify's dev server running:

```
cd mothbot-classify
bun scripts/chrome-harness/bake-game-level.ts <package-dir> <out.zip> <night-id> [night-id…] --detector Mothbot_MBD-0-2.pt
```

The demo pack (`public/levels/bowedBarbo-demo.mothball.zip`, not committed;
see `.gitignore`) is KrkCreate / bowedBarbo, nights 2026-06-22 and
2026-06-28, MBD-0-2 run: 3,288 insects from 0.6 mm specks to 83 mm
hawk-moths, all with calibrated sizes.

### Pack format (v1)

A zip containing:

- `level.json`
- `atlas-N.webp` pages (or `.png` if the baking browser can't encode WebP)

`level.json`:

```jsonc
{
  "format": "mothball-level", "version": 1,
  "title": "2026-06-22 + 2026-06-28", "createdAt": "…",
  "source": { "app": "Mothbot Classify", "nights": ["…"], "detections": 3288 },
  "calibrated": true,               // false if any size fell back to the default camera scale
  "atlases": [{ "file": "atlas-0.webp", "width": 2048, "height": 1980 }],
  "bugs": [{
    "id": "<patch id>",
    "label": "Lepidoptera",         // deepest name known
    "rank": "order",
    "order": "Lepidoptera",
    "human": true,                  // only when a person identified it
    "t": 747.1,                     // capture time, minutes after 12:00 noon
    "areaMm2": 1944.07,             // silhouette area (Process pixel mass × calibration)
    "mmPerPx": 0.4535,              // mm per atlas pixel
    "atlas": 0, "x": 2, "y": 2, "w": 98, "h": 128,   // sprite frame
    "hull": [-46, -64, …],          // convex collision hull, sprite px around the centre, y down, ≤ 10 points
    "cluster": 57.1
  }]
}
```

Hulls are traced from an opened silhouette mask, so legs and antennae don't
make invisible bumpers. Sprites are capped at 128 px on their long side.

## Tools

| | |
|---|---|
| `bun scripts/level-report.ts <pack.zip> [seed]` | Each zone's area, height, the lip that leads there, its alternative paths and insect counts |
| `bun scripts/calibrate-climb.ts` | Measures climbable solid step heights with the real physics |
| `bun scripts/playtest.ts [out-dir] [url]` | Headless Chrome bot: holds →, hops, logs the ball's state, saves screenshots (needs `bun dev`) |
| `BOT=route bun scripts/playtest.ts …` | A bot that roams each area and takes the way up once it's big enough; shows the whole night is playable |
| `bun test` | Level generation: every insect placed once, zones double, no path reachable from below without its size, zones not left to right. One-way ground with the real physics: lip reach, a generated connector letting the right size up (and not a smaller ball), lumpy balls riding paths, spines unable to hook from below or skip a gate. Silhouette tracing. |

URL flags: `?debug` draws colliders and shows fps, `?test` exposes `window.__game`,
`?night=60` makes the night 60 s long.

All tuning lives in `src/tuning.ts`.

## Logo

The mark is the [Mothbox](https://github.com/Digital-Naturalism-Laboratories/Mothbox)
logo (rays, moth and box, from `Mothbox/docs/assets/images/logos/Mothbox Logo
Wide.svg`) set inside a glowing ball, the UV lamp: `src/assets/logo-ball.svg`,
also the favicon. The name is set in Big Shoulders Stencil, the Mothbox logo's
lettering (SIL Open Font License, `src/assets/fonts/OFL.txt`).

## Stack

Vite + TypeScript, [PixiJS 8](https://pixijs.com) for drawing,
[Rapier 2D](https://rapier.rs) for physics, and fflate for the zips. It runs
as a static site with no backend.
