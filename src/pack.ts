/**
 * Level packs: a zip with `level.json` and texture-atlas pages, baked by
 * Mothbot Classify's Visualizer ("Export game level"). See README for the format.
 */
import { strFromU8, unzipSync } from 'fflate'
import { silhouetteHulls } from './silhouette'

export const PACK_FORMAT = 'mothball-level'
export const PACK_VERSION = 1

export type PackBug = {
  id: string
  label: string
  rank: string
  order?: string
  human?: boolean
  /** Capture time, minutes after 12:00 noon (21:30 → 570). */
  t?: number
  areaMm2: number
  mmPerPx: number
  atlas: number
  x: number
  y: number
  w: number
  h: number
  /** Convex hull, flat [x, y, …] in sprite pixels around the sprite centre, y down. */
  hull: number[]
  cluster?: number
}

export type LevelPack = {
  format: string
  version: number
  title: string
  createdAt: string
  source: { app: string; nights: string[]; detections: number }
  calibrated: boolean
  atlases: Array<{ file: string; width: number; height: number }>
  bugs: PackBug[]
}

export type LoadedPack = {
  level: LevelPack
  atlases: ImageBitmap[]
  /** Whole-silhouette hull per insect (legs and all), sprite px like `PackBug.hull`: their shape once stuck to the ball. */
  silhouettes: number[][]
}

export async function loadPackFromUrl(url: string, onProgress?: (msg: string) => void): Promise<LoadedPack> {
  onProgress?.('Downloading level…')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`)
  return loadPackFromBytes(new Uint8Array(await res.arrayBuffer()), onProgress)
}

export async function loadPackFromBytes(bytes: Uint8Array, onProgress?: (msg: string) => void): Promise<LoadedPack> {
  onProgress?.('Unpacking…')
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('That file is not a zip. Level packs are .mothball.zip files from Classify.')
  }
  const json = files['level.json']
  if (!json) throw new Error('No level.json in this zip — is it a Mothball level pack?')
  const level = JSON.parse(strFromU8(json)) as LevelPack
  if (level.format !== PACK_FORMAT) throw new Error(`Unknown level format "${level.format}"`)
  if (level.version > PACK_VERSION) throw new Error(`This pack is format v${level.version}; this game reads up to v${PACK_VERSION}. Update the game.`)

  onProgress?.(`Decoding ${level.atlases.length} sprite sheets…`)
  const atlases = await Promise.all(level.atlases.map(async (a) => {
    const data = files[a.file]
    if (!data) throw new Error(`Pack is missing ${a.file}`)
    const type = a.file.endsWith('.png') ? 'image/png' : 'image/webp'
    return createImageBitmap(new Blob([data as BlobPart], { type }))
  }))
  onProgress?.('Tracing legs…')
  await new Promise((r) => setTimeout(r, 0)) // let the message paint
  return { level, atlases, silhouettes: silhouetteHulls(atlases, level.bugs) }
}

/** Hull in millimetres around the insect's centre. */
export function hullMm(bug: PackBug): number[] {
  return bug.hull.map((v) => v * bug.mmPerPx)
}

/** Longest dimension (mm) and the angle of that axis in the sprite. */
export function longAxis(hull: number[]): { length: number; angle: number } {
  let best = 0, angle = 0
  for (let i = 0; i < hull.length; i += 2) {
    for (let j = i + 2; j < hull.length; j += 2) {
      const dx = hull[j]! - hull[i]!, dy = hull[j + 1]! - hull[i + 1]!
      const d = Math.hypot(dx, dy)
      if (d > best) { best = d; angle = Math.atan2(dy, dx) }
    }
  }
  return { length: best, angle }
}
