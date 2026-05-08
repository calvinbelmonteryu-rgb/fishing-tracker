const express = require('express');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const path = require('path');
const { initDb, storeLandingData, getCountsByDate, getRecentDates, getSpeciesTrend, getAllSpecies } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const db = initDb();

app.use(express.static(path.join(__dirname, 'public')));

// --- Utility functions ---

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  // Handle MM/DD/YYYY
  const slashMatch = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1]}-${slashMatch[2]}`;

  // Strip "Update for", day names, ordinal suffixes, time
  let cleaned = dateStr
    .replace(/Update for\s*/i, '')
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')
    .replace(/(\d+)(?:st|nd|rd|th)/g, '$1')
    .replace(/\d+:\d+\s*[AP]M/i, '')
    .replace(/As of.*/i, '')
    .trim();

  // Match "Apr. 9, 2026" or "April 9, 2026" or "April 9 2026"
  const match = cleaned.match(/(\w+)\.?\s+(\d+),?\s*(\d{4})/);
  if (match) {
    const monthKey = match[1].toLowerCase().replace('.', '');
    const month = MONTHS[monthKey];
    if (month !== undefined) {
      const day = match[2].padStart(2, '0');
      const monthStr = String(month + 1).padStart(2, '0');
      return `${match[3]}-${monthStr}-${day}`;
    }
  }

  return null;
}

function parseFishCountString(str) {
  if (!str) return [];
  if (str.toLowerCase() === 'no report' || str.toLowerCase() === 'no count') return [];
  // Clean trailing junk (JavaScript, HTML, etc.)
  str = str.replace(/\s*(?:Fish Counts Powered|window\.|function\s|gtag|dataLayer|\$\()[\s\S]*/i, '').trim();
  const results = [];
  const parts = str.split(',');
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)\s+([A-Za-z][A-Za-z\s()]*)/);
    if (match) {
      let species = match[2].trim().replace(/\s*Released$/i, ' (Released)');
      // Only accept if species looks like a real fish name (no JS code)
      if (species.length < 30 && !/[{}()=;]/.test(species)) {
        results.push({ species, count: parseInt(match[1], 10) });
      }
    }
  }
  return results;
}

function isBoatRow(boatName, tripType) {
  if (!boatName) return false;
  const lower = boatName.toLowerCase();
  if (lower === 'boat') return false;
  if (lower.includes('dock totals')) return false;
  if (/^\d+ boats?$/i.test(boatName)) return false;
  // "San Diego" in boat column with "N Trips" in trip type = summary row, not a boat
  if (lower === 'san diego' && tripType && /^\d+ trips?$/i.test(tripType)) return false;
  return true;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    timeout: 10000,
  });
  return res.text();
}

// --- Parsers (all return normalized shape) ---

function parseSeaforth(html) {
  const $ = cheerio.load(html);
  let rawDate = '';
  const entries = [];

  $('h2, h3, h4').each((_, el) => {
    const text = $(el).text().trim();
    if (text.includes('Update for')) rawDate = text;
  });

  const headings = $('h4');
  headings.each((_, el) => {
    const heading = $(el).text().trim();
    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    if (!heading || heading.includes('Update') || dayNames.some(d => heading.includes(d))) return;

    // Collect narrative text
    const textParts = [];
    const nextUl = $(el).next('ul');
    if (nextUl.length) {
      nextUl.find('li').each((_, li) => textParts.push($(li).text().trim()));
    }

    const fullText = textParts.join(' ');

    // Extract fish counts from narrative
    // Match "31 Bluefin Tuna", "9 very nice grade Yellowtail" (up to 5 words between number and species)
    const SPECIES_LIST = 'Bluefin Tuna|Yellowfin Tuna|Yellowtail|Dorado|Wahoo|Rockfish|Red Rockfish|Calico Bass|Sand Bass|Halibut|Sculpin|Bonito|Sheephead|Lingcod|Whitefish|White Seabass|Barracuda|Skipjack|Bluefin|Yellowfin';
    const fishCounts = [];
    // Match "31 Bluefin Tuna" or "9 very nice grade Yellowtail"
    // Only allow non-numeric words between the count and species (no digits allowed in gap words)
    const directRegex = new RegExp(`(?:^|\\s)(\\d+)\\s+(?:[A-Za-z]+\\s+){0,5}(${SPECIES_LIST})\\b`, 'g');
    let match;
    while ((match = directRegex.exec(fullText)) !== null) {
      fishCounts.push({ species: match[2], count: parseInt(match[1], 10) });
    }

    // Parse boat name and trip type from heading
    const tripTypes = ['Half Day', 'Full Day', '3/4 Day', 'Open Party', 'Bluefin Tuna', '1.5 Day', '2 Day', '3 Day'];
    let boat = heading;
    let tripType = '';
    for (const tt of tripTypes) {
      if (heading.includes(tt)) {
        boat = heading.replace(tt, '').trim();
        tripType = tt;
        break;
      }
    }

    // Only include entries that have actual fish counts
    if (fishCounts.length > 0) {
      entries.push({
        boat,
        tripType,
        anglers: null,
        fishCounts,
        narrative: null,
      });
    }
  });

  return { date: normalizeDate(rawDate), entries, dockTotals: null };
}

function parseTablePage(html, landingLabel) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  // Find all date strings on the page for per-table association
  const datePattern = /(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/gi;
  const allPageDates = [];
  let dm;
  while ((dm = datePattern.exec(bodyText)) !== null) {
    const d = normalizeDate(dm[1]);
    if (d && !allPageDates.includes(d)) allPageDates.push(d);
  }

  // Also try "for DATE" pattern
  const forMatch = bodyText.match(/for (\w+ \d+\w*,?\s*\d{4})/i);
  const fallbackDate = forMatch ? normalizeDate(forMatch[1]) : (allPageDates[0] || null);

  // Build a list of all elements in order to associate dates with tables
  const entriesByDate = {};
  let currentDate = fallbackDate;

  // Walk through body children to find date text before tables
  $('body *').each((_, el) => {
    const tag = el.tagName;
    const text = $(el).text().trim();

    // Check if this element contains a date (but is not a table)
    if (tag !== 'table' && tag !== 'tr' && tag !== 'td' && tag !== 'th') {
      const dm2 = text.match(/(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/i);
      if (dm2) {
        const parsed = normalizeDate(dm2[1]);
        if (parsed) currentDate = parsed;
      }
    }
  });

  // Re-walk: associate each table with the most recent date found before it
  // We need to track date context per table
  let dateForNextTable = fallbackDate;
  const tables = $('table');
  const tableEntries = [];

  // Get all elements in document order
  const allElements = $('body').find('*');
  let tableIndex = 0;
  const tableDates = [];
  let trackingDate = fallbackDate;

  allElements.each((_, el) => {
    const $el = $(el);
    const tag = el.tagName;

    // Update date from non-table text elements
    if (tag !== 'table' && tag !== 'tr' && tag !== 'td' && tag !== 'th' && tag !== 'tbody' && tag !== 'thead') {
      // Only check direct text, not children's text
      const directText = $el.clone().children().remove().end().text().trim();
      if (directText) {
        const dm3 = directText.match(/(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/i);
        if (dm3) {
          const parsed = normalizeDate(dm3[1]);
          if (parsed) trackingDate = parsed;
        }
      }
    }

    // When we hit a table, record its date
    if (tag === 'table') {
      tableDates[tableIndex] = trackingDate;
      tableIndex++;
    }
  });

  // Now parse each table with its associated date
  const allEntries = [];
  tables.each((idx, table) => {
    let currentTableDate = tableDates[idx] || fallbackDate;

    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('td, th');
      const cellCount = cells.length;

      // Single-cell rows: date break rows or section headers (colspan rows)
      if (cellCount === 1) {
        const text = $(cells[0]).text().trim();
        // Check if it's a date header
        const dateMatch = text.match(/(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/i);
        if (dateMatch) {
          const parsed = normalizeDate(dateMatch[1]);
          if (parsed) currentTableDate = parsed;
        }
        return;
      }

      // 4-cell rows: Boat, Trip Type, Anglers, Fish Count
      if (cellCount >= 4) {
        const boat = $(cells[0]).text().trim();
        const tripType = $(cells[1]).text().trim();
        const anglersStr = $(cells[2]).text().trim();
        const fishCountStr = $(cells[3]).text().trim();

        // Skip header rows and dock total rows
        if (boat.toLowerCase() === 'boat') return;
        if (fishCountStr.toLowerCase() === 'fish count') return;

        if (isBoatRow(boat, tripType)) {
          allEntries.push({
            date: currentTableDate,
            boat,
            tripType,
            anglers: parseInt(anglersStr, 10) || null,
            fishCounts: parseFishCountString(fishCountStr),
            narrative: null,
          });
        }
      }
    });
  });

  // Group by date — return the most recent date's entries as primary, store all
  // Use the most common date or fallback
  const primaryDate = allEntries.length > 0 ? allEntries[0].date : fallbackDate;
  const entries = allEntries.filter(e => e.date === primaryDate);
  // Also keep other-date entries for multi-date pages (they'll get stored too)
  const extraEntries = allEntries.filter(e => e.date !== primaryDate);

  // Dock totals
  let dockTotals = null;
  const allDockMatches = [...bodyText.matchAll(/Dock Totals?\s*(\d+ Boats?\s+\d+ Trips?\s+\d+ Anglers?\s+[\s\S]*?)(?=Dock Totals|Mexican Limits|San Diego|For more|As of|Give|$)/gi)];
  if (allDockMatches.length > 0) {
    const totalsStr = allDockMatches[allDockMatches.length - 1][1].replace(/\s+/g, ' ').trim();
    const speciesMatch = totalsStr.match(/\d+ Anglers?\s+(.*)/i);
    if (speciesMatch) {
      dockTotals = parseFishCountString(speciesMatch[1].replace(/\s*Mexican Limits.*/i, '').trim());
    }
  }

  return { date: primaryDate, entries, extraEntries, dockTotals };
}

// --- Landing configs ---

const LANDINGS = [
  {
    name: 'Seaforth Sportfishing',
    url: 'https://www.fishcounts.com/seaforth/fishcounts.php',
    website: 'https://www.seaforthlanding.com',
    parse: (html) => parseTablePage(html, 'Seaforth'),
  },
  {
    name: 'Point Loma Sportfishing',
    url: 'https://www.pointlomasportfishing.com/fishcounts.php',
    website: 'https://www.pointlomasportfishing.com',
    parse: (html) => parseTablePage(html, 'Point Loma'),
  },
  {
    name: 'H&M Landing',
    url: 'https://www.fishcounts.com/hmlanding/fishcounts.php',
    website: 'https://www.hmlanding.com',
    parse: (html) => parseTablePage(html, 'H\\s*&\\s*M\\s*Landing'),
  },
  {
    name: "Fisherman's Landing",
    url: 'https://www.fishcounts.com/fishermanslanding/fishcounts.php',
    website: 'https://www.fishermanslanding.com',
    parse: (html) => parseTablePage(html, "Fisherman"),
  },
];

// --- API Routes ---

app.get('/api/fishcounts', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      LANDINGS.map(async (landing) => {
        const html = await fetchPage(landing.url);
        const parsed = landing.parse(html);
        return { name: landing.name, website: landing.website, data: parsed };
      })
    );

    const landings = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { name: LANDINGS[i].name, website: LANDINGS[i].website, error: 'Failed to fetch data' };
    });

    // Merge extraEntries as additional landing data for other dates
    const extraLandings = [];
    for (const landing of landings) {
      if (landing.data && landing.data.extraEntries && landing.data.extraEntries.length > 0) {
        // Group extra entries by date
        const byDate = {};
        for (const e of landing.data.extraEntries) {
          if (!byDate[e.date]) byDate[e.date] = [];
          byDate[e.date].push(e);
        }
        for (const [date, entries] of Object.entries(byDate)) {
          extraLandings.push({
            name: landing.name,
            website: landing.website,
            data: { date, entries, dockTotals: null },
          });
        }
        delete landing.data.extraEntries;
      }
    }
    landings.push(...extraLandings);

    // Store to database
    try {
      storeLandingData(landings);
    } catch (err) {
      console.error('DB storage error:', err.message);
    }

    res.json({ fetchedAt: new Date().toISOString(), landings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/dates', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 30;
  res.json({ dates: getRecentDates(limit) });
});

app.get('/api/history/date/:date', (req, res) => {
  const rows = getCountsByDate(req.params.date);
  // Group by landing and boat
  const landings = {};
  for (const row of rows) {
    if (!landings[row.landing_name]) {
      landings[row.landing_name] = { name: row.landing_name, entries: {} };
    }
    const key = `${row.boat}|${row.trip_type}`;
    if (!landings[row.landing_name].entries[key]) {
      landings[row.landing_name].entries[key] = {
        boat: row.boat,
        tripType: row.trip_type,
        anglers: row.anglers,
        fishCounts: [],
      };
    }
    landings[row.landing_name].entries[key].fishCounts.push({
      species: row.fish_species,
      count: row.fish_count,
    });
  }

  // Convert to array format
  const result = Object.values(landings).map((l) => ({
    name: l.name,
    entries: Object.values(l.entries),
  }));

  res.json({ date: req.params.date, landings: result });
});

app.get('/api/history/species/:species', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const data = getSpeciesTrend(req.params.species, days);
  res.json({ species: req.params.species, data });
});

app.get('/api/history/species', (req, res) => {
  res.json({ species: getAllSpecies() });
});

async function autoFetch() {
  try {
    const results = await Promise.allSettled(
      LANDINGS.map(async (landing) => {
        const html = await fetchPage(landing.url);
        const parsed = landing.parse(html);
        return { name: landing.name, website: landing.website, data: parsed };
      })
    );
    const landings = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { name: LANDINGS[i].name, error: true }
    );
    const extraLandings = [];
    for (const landing of landings) {
      if (landing.data && landing.data.extraEntries && landing.data.extraEntries.length > 0) {
        const byDate = {};
        for (const e of landing.data.extraEntries) {
          if (!byDate[e.date]) byDate[e.date] = [];
          byDate[e.date].push(e);
        }
        for (const [date, entries] of Object.entries(byDate)) {
          extraLandings.push({ name: landing.name, website: landing.website, data: { date, entries, dockTotals: null } });
        }
        delete landing.data.extraEntries;
      }
    }
    landings.push(...extraLandings);
    storeLandingData(landings);
    console.log('Auto-fetch complete:', new Date().toISOString());
  } catch (err) {
    console.error('Auto-fetch error:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Fishing Tracker running at http://localhost:${PORT}`);
  autoFetch();
  setInterval(autoFetch, 60 * 60 * 1000);
});
