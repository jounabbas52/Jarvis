// flight_finder — the Node port of actions/flight_finder.py.
//
// Opens a Google Flights query through browser_control (natively, as Mark
// does), reads the page text through the automation browser, and has Gemini
// extract the options.

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** strptime with one of Mark's four formats, strictly (no overflowed dates). */
function tryFormats(raw) {
  const m = raw.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/);
  if (!m) return null;
  const [, a, sep, b, y] = m;
  // Mark's order: %d/%m/%Y, %m/%d/%Y, %d.%m.%Y, %d-%m-%Y
  const orders = sep === '/' ? [[a, b], [b, a]] : [[a, b]];
  for (const [d, mo] of orders) {
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (dt.getMonth() === Number(mo) - 1 && dt.getDate() === Number(d)) return ymd(dt);
  }
  return null;
}

async function parseDate(raw, ctx) {
  raw = String(raw || '').trim();
  const lower = raw.toLowerCase();
  const today = new Date();

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const f = tryFormats(raw);
  if (f) return f;

  // English fast-path only — Gemini below normalises any language.
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  for (const [key, val] of [
    ['today', today],
    ['tomorrow', tomorrow],
  ]) {
    if (lower.includes(key)) return ymd(val);
  }

  try {
    const result = String(
      await ctx.gemini.text(
        `Today is ${ymd(today)}. Convert this date expression to YYYY-MM-DD: '${raw}'. ` +
          'Return ONLY the date string, nothing else.',
        { tier: ctx.gemini.FAST },
      ),
    ).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(result)) return result;
  } catch (e) {
    console.log(`[FlightFinder] ⚠️ Gemini date parse failed: ${e?.message || e}`);
  }

  for (const [name, num] of Object.entries(MONTH_MAP)) {
    if (lower.includes(name)) {
      const dm = raw.match(/\d{1,2}/);
      if (dm) {
        const day = parseInt(dm[0], 10);
        const year = num >= today.getMonth() + 1 ? today.getFullYear() : today.getFullYear() + 1;
        return `${year}-${pad(num)}-${pad(day)}`;
      }
    }
  }

  console.log(`[FlightFinder] ⚠️ Could not parse date '${raw}' — using today.`);
  return ymd(today);
}

const CABIN_CODE = { economy: '1', premium: '2', business: '3', first: '4' };

function buildGoogleFlightsUrl(origin, destination, date, returnDate = null, passengers = 1, cabin = 'economy') {
  const cabinCode = CABIN_CODE[cabin.toLowerCase()] || '1';
  const base = 'https://www.google.com/travel/flights';
  // Google Flights accepts these query params for pre-filling (Mark builds
  // the q= text with raw '+' separators and no escaping; kept identical).
  const trip = returnDate
    ? `Flights+from+${origin}+to+${destination}+on+${date}+returning+${returnDate}`
    : `Flights+from+${origin}+to+${destination}+on+${date}`;
  return (
    `${base}?q=${trip}` +
    '&tfs=CBwQAhoeEgoyMDI1LTAzLTE1agcIARIDSVNUcgcIARIDTEhS' +
    '&curr=USD' +
    `&cabin=${cabinCode}` +
    `&adults=${passengers}`
  );
}

async function searchFlightsBrowser(ctx, origin, destination, date, returnDate, passengers, cabin) {
  const { browserControl } = require('./browser_control');
  const url = buildGoogleFlightsUrl(origin, destination, date, returnDate, passengers, cabin);
  console.log(`[FlightFinder] 🌐 Opening: ${url}`);
  await browserControl({ action: 'go_to', url }, ctx);
  await new Promise((r) => setTimeout(r, 5_000));
  const raw = await browserControl({ action: 'get_text' }, ctx);
  return [raw || '', url];
}

async function parseFlightsWithGemini(ctx, rawText, origin, destination, date) {
  const prompt =
    `Extract flight options from ${origin} to ${destination} on ${date} ` +
    `from this Google Flights page text:\n\n${rawText.slice(0, 12000)}\n\n` +
    'Return a JSON array of up to 5 flights:\n' +
    '[{"airline":"...","departure":"HH:MM","arrival":"HH:MM",' +
    '"duration":"Xh Ym","stops":0,"price":"...","currency":"USD"}]\n' +
    'If no flights found, return: []';
  try {
    const r = await ctx.gemini.call(prompt, {
      tier: ctx.gemini.SMART,
      timeoutMs: 30_000,
      config: {
        systemInstruction:
          'You are a flight data extraction expert. ' +
          'Extract flight information from raw webpage text. ' +
          'Return ONLY valid JSON — no markdown, no explanation.',
      },
    });
    if (!r) throw new Error('every Gemini model on the ladder failed');
    const text = String(r.text || '')
      .replace(/```(?:json)?/g, '')
      .trim()
      .replace(/`+$/, '')
      .trim();
    const flights = JSON.parse(text);
    return Array.isArray(flights) ? flights : [];
  } catch (e) {
    console.log(`[FlightFinder] ⚠️ Gemini parse failed: ${e?.message || e}`);
    return [];
  }
}

const priceNum = (p) => parseInt(String(p).replace(/[^\d]/g, '') || '999999', 10);

function formatSpoken(flights, origin, destination, date) {
  if (!flights.length) {
    return (
      `I couldn't find any flights from ${origin} to ${destination} ` +
      `on ${date}, sir. The page may not have loaded correctly.`
    );
  }
  const lines = [`Here are the top flights from ${origin} to ${destination} on ${date}, sir.`];
  flights.slice(0, 5).forEach((f, i) => {
    const airline = f.airline ?? 'Unknown airline';
    const departure = f.departure ?? '--:--';
    const arrival = f.arrival ?? '--:--';
    const duration = f.duration ?? '';
    const stops = f.stops ?? 0;
    const price = f.price ?? '';
    const currency = f.currency ?? '';
    const stopStr = stops === 0 ? 'non-stop' : `${stops} stop${stops > 1 ? 's' : ''}`;
    const priceStr = price ? `${price} ${currency}`.trim() : 'price unavailable';
    const durStr = duration ? `, ${duration}` : '';
    lines.push(`Option ${i + 1}: ${airline}, departing ${departure}, arriving ${arrival}${durStr}, ${stopStr}, ${priceStr}.`);
  });
  const priced = flights.filter((f) => f.price);
  if (priced.length) {
    const cheapest = priced.reduce((a, b) => (priceNum(b.price) < priceNum(a.price) ? b : a));
    lines.push(`The cheapest option is ${cheapest.airline} at ${cheapest.price} ${cheapest.currency ?? ''}.`);
  }
  return lines.join(' ');
}

function formatTextReport(flights, origin, destination, date, returnDate, pageUrl) {
  const now = new Date();
  const lines = ['JARVIS — Flight Search Results', '─'.repeat(50), `Route     : ${origin} → ${destination}`, `Date      : ${date}`];
  if (returnDate) lines.push(`Return    : ${returnDate}`);
  lines.push(
    `Searched  : ${ymd(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `Source    : ${pageUrl}`,
    '─'.repeat(50),
    '',
  );
  if (!flights.length) lines.push('No flights found.');
  else {
    flights.forEach((f, i) => {
      const stops = f.stops ?? 0;
      lines.push(
        `Flight ${i + 1}:`,
        `  Airline   : ${f.airline ?? 'N/A'}`,
        `  Departure : ${f.departure ?? 'N/A'}`,
        `  Arrival   : ${f.arrival ?? 'N/A'}`,
        `  Duration  : ${f.duration ?? 'N/A'}`,
        `  Stops     : ${stops === 0 ? 'Non-stop' : `${stops} stop(s)`}`,
        `  Price     : ${f.price ?? 'N/A'} ${f.currency ?? ''}`,
        '',
      );
    });
  }
  return lines.join('\n');
}

function saveToDesktop(ctx, content, origin, destination) {
  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `flights_${origin}_${destination}_${ts}.txt`.replace(/ /g, '_');
  const { saveAndOpen } = require('./youtube_video');
  const filepath = saveAndOpen(ctx, filename, content);
  console.log(`[FlightFinder] 💾 Saved: ${filepath}`);
  return filepath;
}

async function run(parameters, ctx) {
  const params = parameters || {};
  const origin = String(params.origin || '').trim();
  const destination = String(params.destination || '').trim();
  const dateRaw = String(params.date || '').trim();
  const returnRaw = String(params.return_date || '').trim();
  const passengers = Math.max(1, parseInt(params.passengers ?? 1, 10) || 1);
  let cabin = String(params.cabin || 'economy').trim().toLowerCase();
  const save = Boolean(params.save);

  if (!origin || !destination) return 'Please provide both origin and destination, sir.';
  if (!dateRaw) return 'Please provide a departure date, sir.';
  if (!(cabin in CABIN_CODE)) cabin = 'economy';

  const date = await parseDate(dateRaw, ctx);
  const returnDate = returnRaw ? await parseDate(returnRaw, ctx) : null;

  ctx?.ui?.log(`[FlightFinder] ${origin} → ${destination} on ${date}`);
  ctx?.speak?.(`Searching flights from ${origin} to ${destination} on ${date}, sir.`);
  console.log(
    `[FlightFinder] ▶️ ${origin} → ${destination} | ${date}${returnDate ? ` → ${returnDate}` : ''} | ${cabin} | ${passengers} pax`,
  );

  try {
    const [rawText, pageUrl] = await searchFlightsBrowser(ctx, origin, destination, date, returnDate, passengers, cabin);
    if (!rawText) return 'Could not retrieve flight data, sir. The page may not have loaded.';

    ctx?.speak?.('Analysing the results now, sir.');
    const flights = await parseFlightsWithGemini(ctx, rawText, origin, destination, date);
    const spoken = formatSpoken(flights, origin, destination, date);
    ctx?.speak?.(spoken);

    let result = spoken;
    if (save && flights.length) {
      const report = formatTextReport(flights, origin, destination, date, returnDate, pageUrl);
      result += ` Results saved to Desktop: ${saveToDesktop(ctx, report, origin, destination)}`;
    }
    return result;
  } catch (e) {
    console.log(`[FlightFinder] ❌ ${e?.message || e}`);
    return `Flight search failed, sir: ${e?.message || e}`;
  }
}

module.exports = {
  TOOL: {
    name: 'flight_finder',
    description: 'Searches Google Flights and speaks the best options.',
    parameters: {
      type: 'OBJECT',
      properties: {
        origin: { type: 'STRING', description: 'Departure city or airport code' },
        destination: { type: 'STRING', description: 'Arrival city or airport code' },
        date: { type: 'STRING', description: 'Departure date (any format)' },
        return_date: { type: 'STRING', description: 'Return date for round trips' },
        passengers: { type: 'INTEGER', description: 'Number of passengers (default: 1)' },
        cabin: { type: 'STRING', description: 'economy | premium | business | first' },
        save: { type: 'BOOLEAN', description: 'Save results to Notepad' },
      },
      required: ['origin', 'destination', 'date'],
    },
  },
  run,
  parseDate,
  buildGoogleFlightsUrl,
};
