import { googleMaps, googleHotels, googleSearch, mapsReviews } from './searchapi.js'

const safe = (p) => p.catch((e) => { console.warn('[intel] fetch failed:', e.message); return null })

// ─── Scoring helpers ─────────────────────────────────────────────────────────

function reputationLabel(score, max = 5) {
  const n = max === 10 ? score / 2 : score
  if (n >= 4.5) return '✅ Excellent'
  if (n >= 4.0) return '✅ Strong'
  if (n >= 3.7) return '🟡 Moderate'
  if (n >= 3.0) return '⚠️ Weak'
  return '🚨 At Risk'
}

function contentLabel(score) {
  if (score >= 8) return '🟢 Strong'
  if (score >= 5) return '🟡 Adequate'
  return '🔴 Poor'
}

function sgDate() {
  return new Date().toLocaleDateString('en-SG', {
    timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric'
  })
}

function extractSnippetRating(snippet = '', pattern) {
  const m = snippet.match(pattern)
  return m ? m[1] : null
}

function extractThemes(reviews, sentiment) {
  const positiveKw = ['clean','staff','location','view','breakfast','comfortable','friendly','great','excellent','pool','service','room','quiet','modern','spacious']
  const negativeKw = ['noise','wifi','slow','small','dirty','expensive','outdated','parking','cold','rude','wait','old','broken','smell','thin','dated']
  const kws = sentiment === 'positive' ? positiveKw : negativeKw
  const counts = {}
  for (const r of reviews) {
    const text = (r.text || r.snippet || '').toLowerCase()
    for (const kw of kws) {
      if (text.includes(kw)) counts[kw] = (counts[kw] || 0) + 1
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([kw]) => kw.charAt(0).toUpperCase() + kw.slice(1))
}

function rateParity(prices) {
  const rates = prices
    .map(p => p.rate_per_night?.lowest ?? p.price ?? null)
    .filter(r => typeof r === 'number')
  if (rates.length < 2) return null
  const min = Math.min(...rates), max = Math.max(...rates)
  const spread = ((max - min) / min * 100).toFixed(0)
  if (spread <= 5) return `✅ Parity maintained (spread: ${spread}%)`
  if (spread <= 15) return `🟡 Minor parity gap (spread: ${spread}%)`
  return `🚨 Parity violation — ${spread}% gap between cheapest and most expensive OTA`
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runHotelIntel(hotelName, city, onStatus, onChunk) {
  const q = city ? `${hotelName} ${city}` : hotelName
  const cityLabel = city || ''
  const emit = (md) => onChunk(md)

  onStatus('Querying Google Maps…')
  const maps = await safe(googleMaps(q))

  // Grab place info immediately
  const place       = maps?.place_results || maps?.local_results?.[0] || null
  const placeId     = place?.place_id || null
  const googleRating  = place?.rating ?? null
  const googleReviews = place?.reviews ?? place?.reviews_count ?? null
  const address     = place?.address || 'Not found'
  const website     = place?.website || null
  const phone       = place?.phone || null
  const priceRange  = place?.price || place?.price_range || null
  const starType    = place?.type || 'Hotel'

  onStatus('Fetching live OTA pricing…')
  const [hotels, compSearch] = await Promise.all([
    safe(googleHotels(q)),
    safe(googleHotels(`hotels in ${cityLabel || hotelName}`)),
  ])

  onStatus('Searching TripAdvisor & Booking.com…')
  const [taSearch, bkSearch, socialSearch] = await Promise.all([
    safe(googleSearch(`"${hotelName}" ${cityLabel} site:tripadvisor.com`)),
    safe(googleSearch(`"${hotelName}" ${cityLabel} site:booking.com`)),
    safe(googleSearch(`"${hotelName}" ${cityLabel} instagram OR facebook`)),
  ])

  onStatus('Fetching guest reviews…')
  const reviewData   = placeId ? await safe(mapsReviews(placeId)) : null
  const reviewList   = reviewData?.reviews || []
  const positives    = extractThemes(reviewList, 'positive')
  const negatives    = extractThemes(reviewList, 'negative')

  // ── Google Hotels ─────────────────────────────────────────────────────────
  const hotelEntry   = hotels?.hotels_results?.[0] || hotels?.hotels?.[0] || null
  const hotelPrices  = hotelEntry?.prices || []
  const totalReviews = hotelEntry?.reviews ?? googleReviews
  const hotelRating  = hotelEntry?.overall_rating ?? hotelEntry?.rating ?? googleRating

  // ── TripAdvisor ───────────────────────────────────────────────────────────
  const taResult  = taSearch?.organic_results?.find(r => r.link?.includes('tripadvisor.com')) || null
  const taSnippet = taResult?.snippet || ''
  const taUrl     = taResult?.link || null
  const taRatingRaw = extractSnippetRating(taSnippet, /(\d+\.?\d*)\s*(?:out of|\/)\s*5/)
    || extractSnippetRating(taSnippet, /rated?\s+(\d+\.?\d*)/)
  const taRating  = taRatingRaw ? parseFloat(taRatingRaw) : null
  const taReviewMatch = taSnippet.match(/(\d[\d,]+)\s+reviews?/i)
  const taReviews = taReviewMatch ? taReviewMatch[1] : null
  const taRankMatch   = taSnippet.match(/#(\d+)\s+of\s+([\d,]+)/i)
  const taRank    = taRankMatch ? `#${taRankMatch[1]} of ${taRankMatch[2]}` : null

  // ── Booking.com ───────────────────────────────────────────────────────────
  const bkResult  = bkSearch?.organic_results?.find(r => r.link?.includes('booking.com')) || null
  const bkSnippet = bkResult?.snippet || ''
  const bkUrl     = bkResult?.link || null
  const bkScoreRaw = extractSnippetRating(bkSnippet, /(\d+\.?\d*)\s*(?:out of|\/)\s*10/)
    || extractSnippetRating(bkSnippet, /score[:\s]+(\d+\.?\d*)/i)
    || extractSnippetRating(bkSnippet, /rated?\s+(\d+\.?\d*)/i)
  const bkScore   = bkScoreRaw ? parseFloat(bkScoreRaw) : null
  const bkReviewMatch = bkSnippet.match(/(\d[\d,]+)\s+reviews?/i)
  const bkReviews = bkReviewMatch ? bkReviewMatch[1] : null

  // ── Social media ──────────────────────────────────────────────────────────
  const socialResults = socialSearch?.organic_results || []
  const hasFacebook   = socialResults.some(r => r.link?.includes('facebook.com'))
  const hasInstagram  = socialResults.some(r => r.link?.includes('instagram.com'))

  // ── Competitors ───────────────────────────────────────────────────────────
  const competitors = (compSearch?.hotels_results || compSearch?.hotels || [])
    .filter(h => h.name && !h.name.toLowerCase().includes(hotelName.toLowerCase().split(' ')[0].toLowerCase()))
    .slice(0, 5)

  // ── Digital Health Score ──────────────────────────────────────────────────
  let sum = 0, parts = 0
  if (googleRating)  { sum += (googleRating / 5) * 10;  parts++ }
  if (taRating)      { sum += (taRating / 5) * 10;      parts++ }
  if (bkScore)       { sum += bkScore;                  parts++ }
  const dhScore = parts > 0 ? (sum / parts).toFixed(1) : null

  // ── Content quality score (0–10) ─────────────────────────────────────────
  let cq = 0
  if (website)         cq += 3
  if (taUrl)           cq += 2
  if (bkUrl)           cq += 2
  if (hasFacebook)     cq += 1
  if (hasInstagram)    cq += 1
  if (priceRange)      cq += 1

  // ── Red flags ─────────────────────────────────────────────────────────────
  const flags = []
  if (googleRating && googleRating < 3.7)   flags.push(`Google rating **${googleRating}/5** is critically low — expect immediate guest experience overhaul`)
  else if (googleRating && googleRating < 4.0) flags.push(`Google rating **${googleRating}/5** is below chain standard (target ≥ 4.0)`)
  if (bkScore && bkScore < 7.0)              flags.push(`Booking.com score **${bkScore}/10** is critically low — property may be penalised in OTA rankings`)
  else if (bkScore && bkScore < 7.5)         flags.push(`Booking.com score **${bkScore}/10** needs improvement (target ≥ 7.5)`)
  if (!website)                              flags.push('No direct booking website — 100% OTA dependency means high commission exposure (typically 15–25% per booking)')
  if (hotelPrices.length === 0)              flags.push('No live pricing retrieved — manual OTA rate audit required before LOI')
  if (!taUrl)                                flags.push('No TripAdvisor listing found — significant credibility gap for international travellers')
  if (!hasFacebook && !hasInstagram)         flags.push('No social media presence detected — weak direct-to-consumer engagement channel')
  const parityNote = rateParity(hotelPrices)
  if (parityNote && parityNote.includes('🚨')) flags.push(`Rate parity violation: ${parityNote}`)

  // ── Build report ──────────────────────────────────────────────────────────
  onStatus('Building report…')
  const date = sgDate()

  const lowestRate  = hotelPrices[0]?.rate_per_night?.lowest ?? hotelPrices[0]?.price ?? null
  const currency    = hotelPrices[0]?.rate_per_night?.currency ?? hotelEntry?.prices?.[0]?.currency ?? 'USD'

  // Section helper: emit then newline
  const section = (md) => emit(md + '\n')

  // ─────────────────────────────────────────────────
  // HEADER
  // ─────────────────────────────────────────────────
  section(`# 🏨 Hotel Acquisition Intelligence Report`)
  section(``)
  section(`| Field | Detail |`)
  section(`|-------|--------|`)
  section(`| **Property** | ${hotelName} |`)
  section(`| **Location** | ${city ? `${city}` : address} |`)
  section(`| **Address** | ${address} |`)
  section(`| **Category** | ${starType} |`)
  section(`| **Price Range** | ${priceRange || 'N/A'} |`)
  section(`| **Phone** | ${phone || 'N/A'} |`)
  section(`| **Direct Website** | ${website ? `[${website}](${website})` : '⚠️ Not found'} |`)
  section(`| **Report Date** | ${date} SGT |`)
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 1. EXECUTIVE SUMMARY
  // ─────────────────────────────────────────────────
  section(`## 1. Executive Summary`)
  section(``)

  const dhDisplay = dhScore ? `**${dhScore}/10**` : '**N/A** (insufficient data)'
  section(`### Overall Digital Health Score: ${dhDisplay}`)
  section(``)

  // Build summary paragraph from real data
  const repSummary = [
    googleRating ? `Google Maps rating of ${googleRating}/5` : null,
    taRating     ? `TripAdvisor score of ${taRating}/5${taRank ? ` (${taRank})` : ''}` : null,
    bkScore      ? `Booking.com score of ${bkScore}/10` : null,
  ].filter(Boolean)

  if (repSummary.length > 0) {
    section(`${hotelName} has an aggregated digital health score of ${dhScore ?? 'N/A'}/10 based on live data from ${repSummary.length} platform(s): ${repSummary.join(', ')}. ` +
      `The property has ${totalReviews ?? 'an unknown number of'} total guest reviews across platforms.`)
  } else {
    section(`Insufficient platform data found for ${hotelName}. Manual verification required before proceeding with acquisition analysis.`)
  }
  section(``)

  const contentOverall = contentLabel(cq)
  section(`**Content Quality:** ${contentOverall} | **Platforms found:** Google${taUrl ? ', TripAdvisor' : ''}${bkUrl ? ', Booking.com' : ''}${hasFacebook ? ', Facebook' : ''}${hasInstagram ? ', Instagram' : ''}`)
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 2. REPUTATION
  // ─────────────────────────────────────────────────
  section(`## 2. Reputation Analysis`)
  section(``)
  section(`| Platform | Score | Reviews | Status |`)
  section(`|----------|-------|---------|--------|`)
  section(`| Google Maps | ${googleRating ? `${googleRating}/5` : 'N/A'} | ${googleReviews ?? 'N/A'} | ${googleRating ? reputationLabel(googleRating, 5) : '—'} |`)
  section(`| TripAdvisor | ${taRating ? `${taRating}/5` : 'N/A'} | ${taReviews ?? 'N/A'} | ${taRank ? `Rank ${taRank}` : (taUrl ? '✅ Listed' : '❌ Not found')} |`)
  section(`| Booking.com | ${bkScore ? `${bkScore}/10` : 'N/A'} | ${bkReviews ?? 'N/A'} | ${bkScore ? reputationLabel(bkScore, 10) : (bkUrl ? '✅ Listed' : '❌ Not found')} |`)
  section(``)

  if (taUrl) section(`**TripAdvisor listing:** ${taUrl}`)
  if (bkUrl) section(`**Booking.com listing:** ${bkUrl}`)
  section(``)

  if (positives.length > 0) {
    section(`**Top Guest Positives** *(from ${reviewList.length} Google reviews)*`)
    positives.forEach(t => section(`- ${t}`))
    section(``)
  }
  if (negatives.length > 0) {
    section(`**Top Guest Complaints** *(from ${reviewList.length} Google reviews)*`)
    negatives.forEach(t => section(`- ${t}`))
    section(``)
  }
  if (reviewList.length === 0) {
    section(`*Review text data unavailable — Google review fetch did not return results.*`)
    section(``)
  }
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 3. ONLINE CONTENT QUALITY
  // ─────────────────────────────────────────────────
  section(`## 3. Online Content Quality`)
  section(``)
  section(`| Dimension | Status | Assessment |`)
  section(`|-----------|--------|------------|`)
  section(`| Direct Website | ${website ? '✅ Found' : '❌ Not found'} | ${website ? contentLabel(9) : contentLabel(0)} |`)
  section(`| OTA Listings — TripAdvisor | ${taUrl ? '✅ Listed' : '❌ Not found'} | ${taUrl ? contentLabel(8) : contentLabel(0)} |`)
  section(`| OTA Listings — Booking.com | ${bkUrl ? '✅ Listed' : '❌ Not found'} | ${bkUrl ? contentLabel(8) : contentLabel(0)} |`)
  section(`| Live Pricing (OTAs) | ${hotelPrices.length > 0 ? `✅ ${hotelPrices.length} source(s)` : '❌ Not found'} | ${hotelPrices.length >= 3 ? contentLabel(9) : hotelPrices.length > 0 ? contentLabel(6) : contentLabel(0)} |`)
  section(`| Facebook | ${hasFacebook ? '✅ Found' : '❌ Not found'} | ${hasFacebook ? contentLabel(8) : contentLabel(0)} |`)
  section(`| Instagram | ${hasInstagram ? '✅ Found' : '❌ Not found'} | ${hasInstagram ? contentLabel(8) : contentLabel(0)} |`)
  section(``)
  section(`> **Note:** Photography quality cannot be assessed programmatically. A manual review of OTA listing images is recommended.`)
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 4. PRICING & RATE INTELLIGENCE
  // ─────────────────────────────────────────────────
  section(`## 4. Pricing & Rate Intelligence`)
  section(``)

  if (hotelPrices.length > 0) {
    section(`| OTA Platform | Rate / Night | Currency |`)
    section(`|-------------|-------------|---------|`)
    hotelPrices.slice(0, 6).forEach(p => {
      const src  = p.source || p.provider || 'OTA'
      const rate = p.rate_per_night?.lowest ?? p.price ?? p.rate ?? null
      const curr = p.rate_per_night?.currency ?? currency
      section(`| ${src} | ${rate !== null ? rate : 'N/A'} | ${curr} |`)
    })
    section(``)
    if (lowestRate) section(`**Lowest rate found:** ${currency} ${lowestRate}/night`)
    const parity = rateParity(hotelPrices)
    if (parity) section(`**Rate Parity:** ${parity}`)
  } else {
    section(`> ⚠️ No live pricing data retrieved for this property. Manual OTA rate check required.`)
  }
  section(``)

  // Comp set rate positioning
  if (competitors.length > 0) {
    const compRates = competitors
      .map(h => h.prices?.[0]?.rate_per_night?.lowest ?? h.prices?.[0]?.price ?? null)
      .filter(r => r !== null)
    if (compRates.length > 0 && lowestRate) {
      const avgComp = (compRates.reduce((a, b) => a + b, 0) / compRates.length).toFixed(0)
      const diff    = (((lowestRate - avgComp) / avgComp) * 100).toFixed(0)
      const pos     = diff > 5 ? `🔴 Priced **${Math.abs(diff)}% above** comp set average (${currency} ${avgComp}/night)`
                    : diff < -5 ? `🟢 Priced **${Math.abs(diff)}% below** comp set average (${currency} ${avgComp}/night) — potential upside`
                    : `🟡 In line with comp set average (${currency} ${avgComp}/night)`
      section(`**Comp Set Positioning:** ${pos}`)
    }
  }
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 5. COMPETITIVE LANDSCAPE
  // ─────────────────────────────────────────────────
  section(`## 5. Competitive Landscape`)
  section(``)

  if (competitors.length > 0) {
    section(`| Property | Rating | Reviews | Rate/Night | Check-in |`)
    section(`|----------|--------|---------|-----------|---------|`)
    competitors.forEach(h => {
      const cr   = h.overall_rating ?? h.rating ?? 'N/A'
      const revs = h.reviews ?? 'N/A'
      const rate = h.prices?.[0]?.rate_per_night?.lowest ?? h.prices?.[0]?.price ?? null
      const curr = h.prices?.[0]?.rate_per_night?.currency ?? currency
      const ci   = h.check_in_time ?? 'N/A'
      section(`| ${h.name} | ${cr}/5 | ${revs} | ${rate !== null ? `${curr} ${rate}` : 'N/A'} | ${ci} |`)
    })
  } else {
    section(`> ⚠️ Competitor data unavailable — manual comp set research required.`)
  }
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 6. RED FLAGS
  // ─────────────────────────────────────────────────
  section(`## 6. Red Flags 🚩`)
  section(``)

  if (flags.length > 0) {
    flags.forEach((f, i) => section(`${i + 1}. ${f}`))
  } else {
    section(`✅ No major red flags identified from available data. Standard pre-acquisition due diligence still applies.`)
  }
  section(``)
  section(`---`)
  section(``)

  // ─────────────────────────────────────────────────
  // 7. STRATEGIC RECOMMENDATIONS
  // ─────────────────────────────────────────────────
  section(`## 7. Strategic Recommendations`)
  section(``)

  const recs = buildRecommendations({ googleRating, bkScore, website, hotelPrices, taUrl, hasFacebook, hasInstagram, competitors })
  recs.forEach((r, i) => section(`${i + 1}. ${r}`))
  section(``)
  section(`---`)
  section(``)
  section(`*Sources: Google Maps, Google Hotels, TripAdvisor, Booking.com via SearchApi · Live snapshot ${date} SGT · Full on-site audit and financial due diligence required before LOI.*`)
}

// ─── Recommendations ─────────────────────────────────────────────────────────

function buildRecommendations({ googleRating, bkScore, website, hotelPrices, taUrl, hasFacebook, hasInstagram, competitors }) {
  const recs = []

  // 1. Reputation
  if ((googleRating && googleRating < 4.0) || (bkScore && bkScore < 7.5)) {
    recs.push(`**Reputation recovery programme** — Commission a root-cause analysis of top complaint themes and design a 90-day guest experience improvement roadmap aligned to chain standards before any relaunch announcement.`)
  } else {
    recs.push(`**Leverage reputation assets** — Current review scores are a tangible acquisition asset; integrate them into pre-opening marketing collateral and use them to negotiate OTA positioning on takeover day.`)
  }

  // 2. Direct channel
  if (!website) {
    recs.push(`**Build a direct booking channel immediately** — No brand website means the property bleeds 15–25% commission on every booking. A basic brand site with IBE (Internet Booking Engine) integration should be a Day-1 deliverable post-acquisition.`)
  } else {
    recs.push(`**Direct channel conversion audit** — Assess the existing website's booking funnel conversion rate, mobile performance, and brand alignment. A/B test chain standard landing pages against current design within 60 days.`)
  }

  // 3. Rate parity
  if (hotelPrices.length < 3) {
    recs.push(`**Full OTA rate audit** — Live pricing data was limited. Conduct a manual rate parity check across Booking.com, Expedia, Agoda, and the direct channel. Rate leakage is common in independently operated properties.`)
  } else {
    recs.push(`**Rate parity compliance** — Standardise rates across all OTA channels. Parity violations undermine direct booking strategy and can trigger OTA de-ranking penalties — resolve within 30 days of takeover.`)
  }

  // 4. Photography
  recs.push(`**Photography and visual content refresh** — Commission a professional photography package covering rooms, F&B, facilities, and local context. This is consistently the highest-ROI OTA listing improvement, directly increasing click-through and conversion rates.`)

  // 5. Social / TripAdvisor
  if (!taUrl) {
    recs.push(`**Establish TripAdvisor presence** — No TripAdvisor listing is a credibility gap for international and corporate travellers. Claim or create the listing, import historical reviews, and implement a post-stay review solicitation programme.`)
  } else if (!hasFacebook && !hasInstagram) {
    recs.push(`**Activate social media channels** — No Facebook or Instagram presence detected. Establish brand accounts aligned to chain guidelines, create a 90-day content calendar, and target local feeder markets with paid social on takeover.`)
  } else {
    recs.push(`**Deep review mining** — Extract and analyse the full TripAdvisor and Booking.com review corpus (beyond what automated tools retrieved). Identify operational failure patterns — maintenance, F&B, front desk — before finalising takeover scope and budget.`)
  }

  return recs
}
