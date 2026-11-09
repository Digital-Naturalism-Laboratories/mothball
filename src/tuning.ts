/**
 * Every gameplay knob in one place. World units are millimetres (real insect
 * sizes). Movement values are "per ball radius" so the game feels the same at
 * every size: gravity, speed and hop height scale with the ball, and the
 * camera zooms out in steps as it grows.
 */
export const T = {
  // ── growth ──
  /** Core radius at the start (mm). */
  startRadius: 1.5,
  /** Fraction of a picked-up insect's silhouette area added to the core. */
  growth: 0.22,
  /** An insect can be picked up when its length is below this × core radius. */
  collectRatio: 0.9,
  /**
   * A flying or perched insect sticks once its centre is within this × core
   * radius plus `catchLength` × its length: a little past the core, since the
   * ball you see includes the insects poking out of it.
   */
  catchReach: 1.15,
  catchLength: 0.45,
  /** Max stuck insects that keep their own collider (the lumps). */
  maxLumps: 120,
  /** A stuck insect keeps a collider while it pokes out more than this × radius. */
  lumpPoke: 0.06,
  /** Only insects reaching at least this × radius across become lumps (smaller ones are just decoration). */
  lumpMinLength: 0.12,
  /** How far a new insect may sit out from the core, × its length (it sticks where it touched, even on other insects). */
  stickOut: 0.6,
  /**
   * Insects that fly into the light can hit it head first and stick out like
   * spines; this share of them do (the rest land at an angle). Ground insects
   * stick lying flat. Spines make the ball awkward now and then, not always.
   */
  headFirst: 0.3,
  /**
   * Stuck insects buried deeper than this × radius below the surface are painted
   * into the ball's picture and their sprites dropped, so the ball stays packed
   * with insects all the way in without drawing thousands of sprites.
   */
  bakeDepth: 0.28,
  /** Size of that picture (px square). */
  bakePx: 512,

  // ── movement (screen-relative: radii and seconds) ──
  /** Gravity in radii / s². */
  gravity: 30,
  /** Target spin when rolling (rad/s ≈ radii per second along the ground). */
  rollSpeed: 7,
  /** How fast input can change the spin (rad/s²). */
  rollAccel: 26,
  /** Spin braking when no key is held (rad/s²). */
  brake: 6,
  /** Sideways push while airborne (radii / s²). */
  airControl: 5,
  /** Single hop: height in radii. No double jumps; must touch ground again. */
  hopHeight: 0.75,
  hopCooldown: 0.45,
  friction: 1.4,
  /** Collider density. Everything shares it, so a big insect is a heavy insect. */
  density: 1,

  // ── knock-off ──
  /** Contact force (in multiples of the ball's weight) that shakes insects loose. */
  knockForce: 40,
  knockCooldown: 0.8,

  // ── level layout ──
  /** Each zone doubles the expected radius. */
  zoneGrowth: 2,
  /** Radius needed to reach a zone's area, as a fraction of its start radius. */
  gateFraction: 0.85,
  /** Ground insects get this × their length of ground each (spread out, not a carpet). */
  sitterSpacing: 2.2,
  /** Shortest area, in zone radii. */
  minZoneRadii: 70,
  /** Share of insects from later zones dropped in as too-big obstacles. */
  obstacleShare: 0.05,
  /** Of the insects that don't fly, this share perch on plants (the rest sit on the ground). */
  perchShare: 0.45,
  /**
   * A share of every later zone's insects lives back in an earlier area (one
   * zone back, sometimes two): too big to pick up when you first pass, a taste
   * of what's coming and a reason to come back. Some stand guard upright at the
   * start of an open path, blocking it until you can climb over or roll them up.
   */
  visitors: { share: 0.18, twoBack: 0.3, blockChance: 0.6, blockLength: [1.3, 2.2] as const },
  /** Share of decorative plants that grow big (taller, more leaves, more insects). */
  bigPlantShare: 0.18,

  // ── areas and paths (one-way ground: solid from above, open from below) ──
  paths: {
    /** Each zone's area sits this many of its radii above the area it is reached from. */
    areaLift: 8,
    /**
     * Highest lip a bare ball can hop up onto, × its radius: a 0.75 r hop, and
     * a path holds the ball once its bottom is within 0.15 r of the surface.
     * src/ledges.test.ts measures it with the real physics.
     */
    hopReach: 0.9,
    /**
     * Lips sit this fraction of the hop reach of the ball they ask for, so a
     * ball that size makes the hop with room to spare. A smaller ball can still
     * get up if it's lumpy enough to stand tall or lever itself: sneaking ahead.
     */
    lipEase: 0.85,
    /** A small hop anyone can make, for open paths (× zone radius). */
    openLip: 0.35,
    /** Average rise per run of the connectors' long ramps (the steepest part is twice this). */
    slope: 0.14,
    /** …and of the alternative paths' shorter ones. */
    branchSlope: 0.2,
    /** Flat spots in an area where paths start or arrive (zone radii long). */
    spotLength: 16,
    /** Alternative paths per area. */
    branches: [2, 4] as const,
    /** Share of alternative paths whose lip needs a bigger ball… */
    gatedShare: 0.5,
    /** …this × the zone radius. */
    gatedRadius: [1.15, 1.45] as const,
    /** An alternative path cruises this high above its lip (zone radii)… */
    cruiseLift: [1.6, 2.8] as const,
    /** …for this long (zone radii). */
    cruise: [16, 36] as const,
    /** Insects per length on alternative paths, relative to the area below. */
    density: 2.2,
    /**
     * Gaps in the higher areas (chance per terrain feature) and in some
     * alternative paths: hop them, or be big enough to roll across (about
     * 1.7 × your radius wide), or fall and climb back up. Widths in zone radii.
     */
    gaps: { chance: 0.22, width: [1.6, 2.6] as const, branchChance: 0.35, branchWidth: [1.3, 2.0] as const },
    /**
     * Area ends curl up [run, rise] (zone radii), tall enough that a ball near
     * the zone's top size can't roll over at full speed (it can still hop off).
     */
    endCurl: [3, 3.4] as const,
  },
  ledge: {
    /** A path starts holding an insect-or-core once its lowest point is no more than this × its size below the surface… */
    landBelow: 0.15,
    /** …and lets go once it sinks this far below (it fell through, or was dropped). */
    holdBelow: 0.65,
    /** Solid depth under a path's top surface, in zone radii (invisible). */
    solidDepth: 1.2,
    /** Rolling over a gap, the far edge catches the ball while its centre is this × r above it. */
    gapCatch: 0.5,
    /** ↓ twice within this long (s) drops you through the path you're on. */
    doubleTap: 0.35,
  },

  // ── flyers ──
  /** Chance an insect flies, by order. */
  flyerChance: {
    Lepidoptera: 0.65, Trichoptera: 0.65, Neuroptera: 0.65, Ephemeroptera: 0.6, Diptera: 0.6,
    Hymenoptera: 0.5, Hemiptera: 0.35, Coleoptera: 0.3, default: 0.35,
  } as Record<string, number>,
  /** Flyers notice the light within this many light radii. */
  flyerNotice: 1.0,
  /** Flyers give up on the light beyond this many light radii… */
  flyerGiveUp: 1.7,
  /** …or after circling it this long (s). */
  orbitSeconds: [5, 14] as const,
  /**
   * Insects too big to stick are only weakly drawn to a small ball: a small
   * chance per second of noticing it, a short, wide circle, then a long rest.
   */
  bigFlyers: { notice: 0.3, seconds: [1.5, 3.5] as const, rest: [10, 18] as const },
  /** Scattering insects fly off at this many ball radii per second (they slow down as they go). */
  fleeSpeed: [3.5, 6] as const,
  /** Chance per second that a lit insect takes off to the light. */
  takeoff: { perch: 0.25, rest: 0.04, path: 0.06 },

  // ── light, time ──
  /** Visible light radius in core radii. */
  lightRadius: 7,
  /** Real seconds from dusk to dawn. */
  nightSeconds: 300,
  /** After a flood light ends, it takes this long (s) to recharge. */
  floodRecharge: 12,
  /** The flood light lasts this long (s)… */
  floodSeconds: 3,
  /** …and pulls the camera out to this fraction of its zoom, so you see the wider playfield. */
  floodZoom: 0.4,
  /** Insects within this many light radii may take fright at a flood light… */
  floodScatterRange: 2.2,
  /** …with this chance each. */
  floodScatterChance: 0.5,
  /**
   * A flood light shakes off the insects jutting out more than `poke` × radius,
   * most-jutting first (at most `max`): a way to smooth an awkward ball, at the
   * cost of what they added.
   */
  floodShed: { poke: 0.12, max: 40 },
  /**
   * The flood light also frees a wedged ball: every insect touching it (even one
   * too big to pick up) takes off, and the ball gets a small hop (× radius).
   */
  floodPop: 0.5,
  /** Of the insects that scatter, this share only fly off `scale` as far (the rest go the whole way). */
  fleeShort: { share: 0.5, scale: 0.5 },

  // ── camera ──
  /** Core radius as a fraction of screen height, right after a zoom. */
  cameraRadiusFrac: 0.05,
  /** Zoom out once the ball looks this many times bigger than that (Katamari-style steps). */
  zoomOutAt: 1.7,
} as const
