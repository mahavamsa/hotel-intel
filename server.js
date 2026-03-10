import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runHotelIntel } from './src/intel.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001
const HOST = '127.0.0.1'

app.use(express.static(join(__dirname, 'public')))

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'hotel-intel' }))

app.get('/report', async (req, res) => {
  const hotel = (req.query.hotel || '').trim()
  const city  = (req.query.city  || '').trim()

  if (!hotel) return res.status(400).json({ error: 'Missing required param: hotel' })
  if (!process.env.SEARCHAPI_API_KEY) {
    return res.status(500).json({ error: 'SEARCHAPI_API_KEY not configured' })
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  req.on('close', () => res.end())

  try {
    await runHotelIntel(hotel, city,
      (msg) => send('status', { message: msg }),
      (chunk) => send('chunk', { text: chunk })
    )
    send('done', {})
  } catch (err) {
    console.error('[hotel-intel] Error:', err.message)
    send('error', { message: err.message })
  } finally {
    res.end()
  }
})

app.listen(PORT, HOST, () => {
  console.log(`[hotel-intel] http://${HOST}:${PORT}`)
  if (!process.env.SEARCHAPI_API_KEY) {
    console.warn('[hotel-intel] ⚠️  SEARCHAPI_API_KEY not set — add it to .env')
  }
})
