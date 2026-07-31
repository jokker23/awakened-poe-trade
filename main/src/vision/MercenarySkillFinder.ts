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
// Detection is deliberately plain JavaScript over the pixel buffer. The
// opencv.js shipped in cv-ocr is a reduced build: it has no morphology or
// contour functions (getStructuringElement, dilate, findContours,
// boundingRect are all absent), so the usual dilate-and-find-contours
// approach cannot run here.
const TEXT_MIN_LUMA = 140
// metrics expressed at REFERENCE_HEIGHT, scaled to the real screen below
const MIN_LINE_HEIGHT = 6
const MAX_LINE_HEIGHT = 26
const MIN_LINE_WIDTH = 24
const MAX_LINE_WIDTH = 320
// columns further apart than this belong to separate blocks of text
const COLUMN_GAP = 10
// a row needs this many lit pixels before it counts as part of a text line
const MIN_ROW_PIXELS = 8
// each candidate costs an OCR pass, so cap the work on a busy screen
const MAX_CANDIDATES = 40
const MIN_CONFIDENCE = 30

interface Box { x: number, y: number, width: number, height: number }

interface OcrResult {
  elapsed: number
  candidates: number
  recognized: Array<{ text: string, confidence: number }>
}

/**
 * Locates candidate lines of bright text. Split out from OCR so it can be
 * tested without the tesseract/opencv engine present.
 */
export function findTextBoxes (screenshot: ImageData): { boxes: Box[], lit: Uint8Array } {
  {
    const { width, height, data } = screenshot
    const scale = height / REFERENCE_HEIGHT

    const minLineHeight = Math.round(MIN_LINE_HEIGHT * scale)
    const maxLineHeight = Math.round(MAX_LINE_HEIGHT * scale)
    const minLineWidth = Math.round(MIN_LINE_WIDTH * scale)
    const maxLineWidth = Math.round(MAX_LINE_WIDTH * scale)
    const columnGap = Math.round(COLUMN_GAP * scale)

    // one bit per pixel: is this pixel bright enough to be text
    const lit = new Uint8Array(width * height)
    const rowCount = new Uint32Array(height)
    {
      for (let y = 0; y < height; ++y) {
        let count = 0
        const row = y * width
        for (let x = 0; x < width; ++x) {
          const px = (row + x) * 4
          // BGRA on Windows; the exact channel order barely matters for luma
          const luma = (data[px + 2] * 299 + data[px + 1] * 587 + data[px] * 114) / 1000
          if (luma >= TEXT_MIN_LUMA) {
            lit[row + x] = 1
            count += 1
          }
        }
        rowCount[y] = count
      }
    }

    const boxes: Box[] = []
    {
      let bandStart = -1
      for (let y = 0; y <= height; ++y) {
        const isTextRow = (y < height && rowCount[y] >= MIN_ROW_PIXELS)
        if (isTextRow && bandStart === -1) {
          bandStart = y
        } else if (!isTextRow && bandStart !== -1) {
          const bandHeight = y - bandStart
          if (bandHeight >= minLineHeight && bandHeight <= maxLineHeight) {
            boxes.push(...splitBandIntoBlocks(
              lit, width, bandStart, bandHeight, columnGap, minLineWidth, maxLineWidth))
          }
          bandStart = -1
        }
      }
    }

    return { boxes, lit }
  }
}

export class MercenarySkillFinder {
  ocrScreenshot (screenshot: ImageData): OcrResult {
    let elapsed = 0
    const { width } = screenshot
    const { boxes, lit } = findTextBoxes(screenshot)

    // reading top to bottom keeps the tooltip's own order
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

function splitBandIntoBlocks (
  lit: Uint8Array,
  width: number,
  bandY: number,
  bandHeight: number,
  columnGap: number,
  minWidth: number,
  maxWidth: number
): Box[] {
  // a single row of the screen can hold unrelated text, so cut the band
  // wherever there is a run of empty columns
  const out: Box[] = []
  let blockStart = -1
  let emptyRun = 0

  for (let x = 0; x <= width; ++x) {
    let occupied = false
    if (x < width) {
      for (let y = bandY; y < bandY + bandHeight; ++y) {
        if (lit[y * width + x]) { occupied = true; break }
      }
    }

    if (occupied) {
      if (blockStart === -1) blockStart = x
      emptyRun = 0
    } else if (blockStart !== -1) {
      emptyRun += 1
      if (emptyRun > columnGap || x === width) {
        // x - emptyRun is the last lit column, so +1 for an exclusive end
        const blockWidth = (x - emptyRun + 1) - blockStart
        if (blockWidth >= minWidth && blockWidth <= maxWidth) {
          out.push({ x: blockStart, y: bandY, width: blockWidth, height: bandHeight })
        }
        blockStart = -1
        emptyRun = 0
      }
    }
  }

  return out
}
