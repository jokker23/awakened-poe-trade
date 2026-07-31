import { Worker } from 'worker_threads'
import * as Comlink from 'comlink'
import nodeEndpoint from 'comlink/dist/umd/node-adapter'
import type { WorkerAPI } from './link-worker'
import type { ImageData } from './utils'
import { app } from 'electron'
import path from 'path'
import type { Logger } from '../RemoteLogger'

export class OcrWorker {
  private binDir = path.join(app.getPath('userData'), 'apt-data/cv-ocr')
  private api: Comlink.Remote<WorkerAPI>
  private lang = ''
  public ready = false

  private constructor (private logger?: Logger) {
    const worker = new Worker(__dirname + '/vision.js')
    this.api = Comlink.wrap<WorkerAPI>(nodeEndpoint(worker))
  }

  static async create (logger?: Logger) {
    const worker = new OcrWorker(logger)
    try {
      await worker.api.init(worker.binDir)
      worker.ready = true
      logger?.write(`info [OCR] engine loaded from ${worker.binDir}`)
    } catch (e) {
      // without this the whole feature is a no-op, and used to be a silent one
      logger?.write(`error [OCR] engine unavailable (${(e as Error).message}). Expected files in ${worker.binDir}`)
    }
    return worker
  }

  async updateOptions (lang: string) {
    try {
      if (lang !== this.lang) {
        await this.api.changeLanguage(lang, this.binDir)
        this.logger?.write(`info [OCR] language set to ${lang}`)
      }
    } catch (e) {
      this.logger?.write(`error [OCR] cannot use language "${lang}": ${(e as Error).message}`)
    } finally {
      this.lang = lang
    }
  }

  async findHeistGems (image: ImageData) {
    const result = await this.api.findHeistGems(
      Comlink.transfer(image, [image.data.buffer]))
    return result
  }

  async findMercenarySkills (image: ImageData) {
    const result = await this.api.findMercenarySkills(
      Comlink.transfer(image, [image.data.buffer]))
    return result
  }
}
