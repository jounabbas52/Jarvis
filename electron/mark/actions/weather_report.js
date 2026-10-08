// weather_report — the Node port of actions/weather_report.py.
//
// Mark does not fetch weather itself: it opens a Google search for
// "weather in <city> <when>" in the default browser, where Google shows its
// own weather card.

async function run(parameters, ctx) {
  const params = parameters || {};
  let city = params.city;
  let when = params.time || 'today';
  const log = (msg) => {
    console.log(`[Weather] ${msg}`);
    try {
      ctx?.ui?.log(`JARVIS: ${msg}`);
    } catch {
      /* the log is best effort */
    }
  };

  if (!city || typeof city !== 'string' || !city.trim()) {
    const msg = 'Sir, the city is missing for the weather report.';
    log(msg);
    return msg;
  }
  city = city.trim();
  when = String(when || 'today').trim() || 'today';

  const searchQuery = `weather in ${city} ${when}`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery).replace(/%20/g, '+')}`;

  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
  } catch (e) {
    const msg = `Sir, I couldn't open the browser for the weather report: ${e?.message || e}`;
    log(msg);
    return msg;
  }

  const msg = `Showing the weather for ${city}, ${when}, sir.`;
  log(msg);
  return msg;
}

module.exports = {
  TOOL: {
    name: 'weather_report',
    description: 'Gives the weather report to user',
    parameters: {
      type: 'OBJECT',
      properties: {
        city: { type: 'STRING', description: 'City name' },
      },
      required: ['city'],
    },
  },
  run,
};
