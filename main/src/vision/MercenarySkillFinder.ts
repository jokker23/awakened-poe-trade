import * as Bindings from './wasm-bindings'
import { tessApi } from './wasm-bindings'
import { timeIt, ImageData } from './utils'

const REFERENCE_HEIGHT = 600

// Mercenary Warrant tooltips print the skill list as light text on a dark
// panel. There is no icon to template-match the way heist gems anchor on the
// lock, so every bright text line is read and the renderer resolves them
// against the known skill names — lines that are not skills match nothing and
// are dropped there.
//
// Detection is plain JavaScript over the pixel buffer: the opencv.js shipped
// in cv-ocr is a reduced build with no morphology or contour functions
// (getStructuringElement, dilate, findContours and boundingRect are absent),
// so glyphs are grouped by connected components instead. Grouping has to stay
// local — a screen-wide row projection is destroyed by any tall lit region
// such as an open stash, which fills the rows between the skill lines.
const TEXT_MIN_LUMA = 140
// metrics expressed at REFERENCE_HEIGHT, scaled to the real screen below
const MIN_LINE_HEIGHT = 6
const MAX_LINE_HEIGHT = 26
const MIN_LINE_WIDTH = 24
const MAX_LINE_WIDTH = 320
// glyphs further apart than this belong to separate blocks of text
const COLUMN_GAP = 10
// the skill list is a centred vertical stack, which is how it is told apart
// from the rest of the interface
const STACK_CENTRE_TOLERANCE = 24
const MIN_STACK_SIZE = 3
// each candidate costs an OCR pass, so cap the work on a busy screen
const MAX_CANDIDATES = 40
const MIN_CONFIDENCE = 30

interface Box { x: number, y: number, width: number, height: number }

interface OcrResult {
  elapsed: number
  candidates: number
  recognized: Array<{ text: string, confidence: number }>
}

interface Run { y: number, x0: number, x1: number, root: number }

/**
 * Locates candidate lines of bright text. Split out from OCR so it can be
 * tested without the tesseract/opencv engine present.
 */
export function findTextBoxes (screenshot: ImageData): { boxes: Box[], lit: Uint8Array } {
  const { width, height, data } = screenshot
  const scale = height / REFERENCE_HEIGHT

  const minLineHeight = Math.round(MIN_LINE_HEIGHT * scale)
  const maxLineHeight = Math.round(MAX_LINE_HEIGHT * scale)
  const minLineWidth = Math.round(MIN_LINE_WIDTH * scale)
  const maxLineWidth = Math.round(MAX_LINE_WIDTH * scale)
  const columnGap = Math.round(COLUMN_GAP * scale)
  const centreTolerance = Math.round(STACK_CENTRE_TOLERANCE * scale)

  const lit = new Uint8Array(width * height)
  const runs: Run[] = []

  for (let y = 0; y < height; ++y) {
    const row = y * width
    let runStart = -1
    for (let x = 0; x < width; ++x) {
      const px = (row + x) * 4
      // BGRA on Windows; the exact channel order barely matters for luma
      const luma = (data[px + 2] * 299 + data[px + 1] * 587 + data[px] * 114) / 1000
      const isLit = luma >= TEXT_MIN_LUMA
      if (isLit) {
        lit[row + x] = 1
        if (runStart === -1) runStart = x
      } else if (runStart !== -1) {
        runs.push({ y, x0: runStart, x1: x - 1, root: runs.length })
        runStart = -1
      }
    }
    if (runStart !== -1) runs.push({ y, x0: runStart, x1: width - 1, root: runs.length })
  }

  // union-find over runs; a run joins the one above it when they overlap in x
  const parent = new Int32Array(runs.length)
  for (let i = 0; i < runs.length; ++i) parent[i] = i
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  let prevStart = 0
  let rowStart = 0
  for (let i = 0; i < runs.length; ++i) {
    if (i > 0 && runs[i].y !== runs[i - 1].y) {
      prevStart = rowStart
      rowStart = i
    }
    if (runs[i].y === 0) continue
    for (let j = prevStart; j < rowStart; ++j) {
      if (runs[j].y !== runs[i].y - 1) continue
      if (runs[j].x1 < runs[i].x0 - 1) continue
      if (runs[j].x0 > runs[i].x1 + 1) break
      union(j, i)
    }
  }

  // bounding box per component
  const comps = new Map<number, Box>()
  for (let i = 0; i < runs.length; ++i) {
    const root = find(i)
    const run = runs[i]
    const box = comps.get(root)
    if (!box) {
      comps.set(root, { x: run.x0, y: run.y, width: run.x1 - run.x0 + 1, height: 1 })
    } else {
      const x0 = Math.min(box.x, run.x0)
      const x1 = Math.max(box.x + box.width - 1, run.x1)
      const y1 = Math.max(box.y + box.height - 1, run.y)
      box.x = x0; box.width = x1 - x0 + 1; box.height = y1 - box.y + 1
    }
  }

  // keep things the size of a glyph; panels and bars are dropped here
  const glyphs = Array.from(comps.values()).filter(box =>
    box.height <= maxLineHeight && box.width <= maxLineWidth)

  // group glyphs sharing a row band, then merge those close enough to be one line
  glyphs.sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x)
  const lines: Box[] = []
  let band: Box[] = []
  const flushBand = () => {
    if (!band.length) return
    band.sort((a, b) => a.x - b.x)
    let cur: Box | null = null
    for (const g of band) {
      if (cur && g.x - (cur.x + cur.width) <= columnGap) {
        const x1 = Math.max(cur.x + cur.width - 1, g.x + g.width - 1)
        const y0 = Math.min(cur.y, g.y)
        const y1 = Math.max(cur.y + cur.height - 1, g.y + g.height - 1)
        cur.x = Math.min(cur.x, g.x); cur.width = x1 - cur.x + 1
        cur.y = y0; cur.height = y1 - y0 + 1
      } else {
        if (cur) lines.push(cur)
        cur = { ...g }
      }
    }
    if (cur) lines.push(cur)
    band = []
  }
  for (const g of glyphs) {
    if (band.length) {
      const ref = band[0]
      const refCentre = ref.y + ref.height / 2
      const centre = g.y + g.height / 2
      if (Math.abs(centre - refCentre) > Math.max(ref.height, g.height) / 2) flushBand()
    }
    band.push(g)
  }
  flushBand()

  const boxes = lines.filter(box =>
    box.height >= minLineHeight && box.height <= maxLineHeight &&
    box.width >= minLineWidth && box.width <= maxLineWidth)

  // The skill list is a centred stack of lines. Preferring stacked lines keeps
  // the tooltip inside the OCR budget on a screen full of other text.
  const stacked: Box[] = []
  const loose: Box[] = []
  for (const box of boxes) {
    const centre = box.x + box.width / 2
    const peers = boxes.filter(other =>
      Math.abs((other.x + other.width / 2) - centre) <= centreTolerance)
    ;(peers.length >= MIN_STACK_SIZE ? stacked : loose).push(box)
  }
  const ordered = [...stacked, ...loose]
  ordered.sort((a, b) => {
    const aStacked = stacked.includes(a) ? 0 : 1
    const bStacked = stacked.includes(b) ? 0 : 1
    return aStacked - bStacked || a.y - b.y
  })

  return { boxes: ordered, lit }
}

export class MercenarySkillFinder {
  ocrScreenshot (screenshot: ImageData): OcrResult {
    let elapsed = 0
    const { width } = screenshot
    const { boxes, lit } = findTextBoxes(screenshot)
    const candidates = boxes.slice(0, MAX_CANDIDATES)

    const recognized: OcrResult['recognized'] = []
    for (const box of candidates) {
      // tesseract wants dark text on a light background
      const buf = new Uint8Array(box.width * box.height)
      for (let y = 0; y < box.height; ++y) {
        const src = (box.y + y) * width + box.x
        const dst = y * box.width
        for (let x = 0; x < box.width; ++x) {
          buf[dst + x] = lit[src + x] ? 0 : 255
        }
      }

      Bindings.ocrSetImage(buf, box.width, box.height, 1)
      tessApi.SetVariable('tessedit_pageseg_mode', '7') // single line
      elapsed += timeIt(() => {
        tessApi.Recognize()
      })
      const text = (tessApi.GetUTF8Text() as string).trim()
      const confidence = tessApi.MeanTextConf()
      if (text.length > 0 && confidence > MIN_CONFIDENCE) {
        recognized.push({ text, confidence })
      }
    }

    return { elapsed, candidates: candidates.length, recognized }
  }
}
