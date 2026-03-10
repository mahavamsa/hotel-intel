const BASE_URL = 'https://www.searchapi.io/api/v1/search'

async function call(engine, params) {
  const url = new URL(BASE_URL)
  url.searchParams.set('api_key', process.env.SEARCHAPI_API_KEY)
  url.searchParams.set('engine', engine)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`SearchApi [${engine}] HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

// Check-in tomorrow, check-out day after
function checkInOut() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const ci = d.toISOString().slice(0, 10)
  d.setDate(d.getDate() + 1)
  const co = d.toISOString().slice(0, 10)
  return { check_in_date: ci, check_out_date: co }
}

export const googleMaps     = (q)        => call('google_maps',         { q, type: 'search' })
export const mapsReviews    = (place_id) => call('google_maps_reviews', { place_id, sort_by: 'newestFirst', num: 30 })
export const googleHotels   = (q)        => call('google_hotels',       { q, ...checkInOut(), adults: 2 })
export const googleSearch   = (q)        => call('google',              { q, num: 10 })
