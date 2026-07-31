import * as Bindings from './wasm-bindings'
import { cv, tessApi } from './wasm-bindings'
import { timeIt, ImageData } from './utils'

const REFERENCE_HEIGHT = 600

// Mercenary Warrant tooltips print the skill list as light text on a dark
// panel. There is no icon we can template-match the way heist gems anchor on
// the lock, so instead every bright text line is read and the caller resolves
// them against the known skill names — lines that are not skills match nothing
// and are dropped there.
const TEXT_MIN_BRIGHTNESS = 140
// line metrics measured at REFERENCE_HEIGHT
const MIN_LINE_HEIGHT = 6
const MAX_LINE_HEIGHT = 26
const MIN_LINE_WIDTH = 24
const MAX_LINE_WIDTH = 320
// each candidate costs an OCR pass, so cap the work on a busy screen
const MAX_CANDIDATES = 40
const MIN_CONFIDENCE = 30

interface OcrResult {
  elapsed: number
  candidates: number
  recognized: Array<{ text: string, confidence: number }>
}

export class MercenarySkillFinder {
  ocrScreenshot (screenshot: ImageData): OcrResult {
    let elapsed = 0
    const colorMat = Bindings.cvMatFromImage(screenshot)
    const scale = screenshot.height / REFERENCE_HEIGHT

    const grayMat = new cv.Mat()
    const maskMat = new cv.Mat()
    elapsed += timeIt(() => {
      cv.resize(colorMat, grayMat,
        new cv.Size(Math.floor(screenshot.width / scale), REFERENCE_HEIGHT),
        0, 0, cv.INTER_LINEAR)
      cv.cvtColor(grayMat, grayMat, cv.COLOR_BGR2GRAY)
      cv.threshold(grayMat, maskMat, TEXT_MIN_BRIGHTNESS, 255, cv.THRESH_BINARY)
      // merge the glyphs of one line into a single blob so each line is one contour
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(12, 1))
      cv.dilate(maskMat, maskMat, kernel)
      kernel.delete()
    })
    grayMat.delete()

    const boxes: Array<{ x: number, y: number, width: number, height: number }> = []
    {
      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      cv.findContours(maskMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      for (let i = 0; i < contours.size(); ++i) {
        const contour = contours.get(i)
        const rect = cv.boundingRect(contour)
        contour.delete()
        if (rect.height < MIN_LINE_HEIGHT || rect.height > MAX_LINE_HEIGHT) continue
        if (rect.width < MIN_LINE_WIDTH || rect.width > MAX_LINE_WIDTH) continue
        boxes.push(rect)
      }
      contours.delete()
      hierarchy.delete()
      maskMat.delete()
    }

    // skill names sit close together; reading top-to-bottom keeps tooltip order
    boxes.sort((a, b) => a.y - b.y)
    const candidates = boxes.slice(0, MAX_CANDIDATES)

    const recognized: OcrResult['recognized'] = []
    for (const box of candidates) {
      // crop from the full resolution image, tesseract needs the detail
      const pad = 2
      const x = Math.max(0, Math.round((box.x - pad) * scale))
      const y = Math.max(0, Math.round((box.y - pad) * scale))
      const width = Math.min(colorMat.cols - x, Math.round((box.width + pad * 2) * scale))
      const height = Math.min(colorMat.rows - y, Math.round((box.height + pad * 2) * scale))
      if (width <= 0 || height <= 0) continue

      const roiColor = colorMat.roi(new cv.Rect(x, y, width, height))
      const roiText = new cv.Mat()
      elapsed += timeIt(() => {
        cv.cvtColor(roiColor, roiText, cv.COLOR_BGR2GRAY)
        cv.threshold(roiText, roiText, TEXT_MIN_BRIGHTNESS, 255, cv.THRESH_BINARY)
        // tesseract expects dark text on a light background
        cv.bitwise_not(roiText, roiText)
      })
      roiColor.delete()

      Bindings.ocrSetImage(roiText.data, roiText.cols, roiText.rows, roiText.channels())
      roiText.delete()
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
    colorMat.delete()

    return { elapsed, candidates: candidates.length, recognized }
  }
}
