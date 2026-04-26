import { app } from 'electron'
import { createWriteStream, type WriteStream } from 'fs'
import { join } from 'path'
import type { ServerEvents } from './server'

export class Logger {
  history = ''
  private fileStream: WriteStream

  constructor (
    private server: ServerEvents
  ) {
    const logPath = join(app.getPath('userData'), 'debug.log')
    this.fileStream = createWriteStream(logPath, { flags: 'a' })
    this.fileStream.write(`\n=== session start ${new Date().toISOString()} (pid ${process.pid}) ===\n`)
    this.fileStream.write(`log path: ${logPath}\n`)
  }

  write (message: string) {
    message = `[${new Date().toLocaleTimeString()}] ${message}\n`
    this.history += message
    this.fileStream.write(message)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::log-entry',
      payload: { message }
    })
  }
}
