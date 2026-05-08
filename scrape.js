// Standalone scraper for GitHub Actions (or any cron).
// Fetches all landings, parses the fish counts, and writes:
//   data/latest.json         — most recent scrape
//   data/history/YYYY-MM-DD.json — daily snapshot (keyed by source date)

const cheerio = require('cheerio');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const slashMatch = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1]}-${slashMatch[2]}`;

  let cleaned = dateStr
    .replace(/Update for\s*/i, '')
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')
    .replace(/(\d+)(?:st|nd|rd|th)/g, '$1')
    .replace(/\d+:\d+\s*[AP]M/i, '')
    .replace(/As of.*/i, '')
    .trim();

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
  str = str.replace(/\s*(?:Fish Counts Powered|window\.|function\s|gtag|dataLayer|\$\()[\s\S]*/i, '').trim();
  const results = [];
  for (const part of str.split(',')) {
    const match = part.trim().match(/^(\d+)\s+([A-Za-z][A-Za-z\s()]*)/);
    if (match) {
      let species = match[2].trim().replace(/\s*Released$/i, ' (Released)');
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
  if (lower === 'san diego' && tripType && /^\d+ trips?$/i.test(tripType)) return false;
  return true;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    timeout: 10000,
  });
  return res.text();
}

function parseTablePage(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  const datePattern = /(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/gi;
  const allPageDates = [];
  let dm;
  while ((dm = datePattern.exec(bodyText)) !== null) {
    const d = normalizeDate(dm[1]);
    if (d && !allPageDates.includes(d)) allPageDates.push(d);
  }

  const forMatch = bodyText.match(/for (\w+ \d+\w*,?\s*\d{4})/i);
  const fallbackDate = forMatch ? normalizeDate(forMatch[1]) : (allPageDates[0] || null);

  const tables = $('table');
  const allElements = $('body').find('*');
  let tableIndex = 0;
  const tableDates = [];
  let trackingDate = fallbackDate;

  allElements.each((_, el) => {
    const $el = $(el);
    const tag = el.tagName;
    if (tag !== 'table' && tag !== 'tr' && tag !== 'td' && tag !== 'th' && tag !== 'tbody' && tag !== 'thead') {
      const directText = $el.clone().children().remove().end().text().trim();
      if (directText) {
        const dm3 = directText.match(/(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/i);
        if (dm3) {
          const parsed = normalizeDate(dm3[1]);
          if (parsed) trackingDate = parsed;
        }
      }
    }
    if (tag === 'table') {
      tableDates[tableIndex] = trackingDate;
      tableIndex++;
    }
  });

  const allEntries = [];
  tables.each((idx, table) => {
    let currentTableDate = tableDates[idx] || fallbackDate;
    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('td, th');
      const cellCount = cells.length;

      if (cellCount === 1) {
        const text = $(cells[0]).text().trim();
        const dateMatch = text.match(/(?:\w+day\s+)?(\w+ \d+(?:st|nd|rd|th)?,?\s*\d{4})/i);
        if (dateMatch) {
          const parsed = normalizeDate(dateMatch[1]);
          if (parsed) currentTableDate = parsed;
        }
        return;
      }

      if (cellCount >= 4) {
        const boat = $(cells[0]).text().trim();
        const tripType = $(cells[1]).text().trim();
        const anglersStr = $(cells[2]).text().trim();
        const fishCountStr = $(cells[3]).text().trim();

        if (boat.toLowerCase() === 'boat') return;
        if (fishCountStr.toLowerCase() === 'fish count') return;

        if (isBoatRow(boat, tripType)) {
          allEntries.push({
            date: currentTableDate,
            boat,
            tripType,
            anglers: parseInt(anglersStr, 10) || null,
            fishCounts: parseFishCountString(fishCountStr),
          });
        }
      }
    });
  });

  const primaryDate = allEntries.length > 0 ? allEntries[0].date : fallbackDate;
  const entries = allEntries.filter(e => e.date === primaryDate);
  const extraEntries = allEntries.filter(e => e.date !== primaryDate);

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

const LANDINGS = [
  { name: 'Seaforth Sportfishing', url: 'https://www.fishcounts.com/seaforth/fishcounts.php', website: 'https://www.seaforthlanding.com' },
  { name: 'Point Loma Sportfishing', url: 'https://www.pointlomasportfishing.com/fishcounts.php', website: 'https://www.pointlomasportfishing.com' },
  { name: 'H&M Landing', url: 'https://www.fishcounts.com/hmlanding/fishcounts.php', website: 'https://www.hmlanding.com' },
  { name: "Fisherman's Landing", url: 'https://www.fishcounts.com/fishermanslanding/fishcounts.php', website: 'https://www.fishermanslanding.com' },
];

async function main() {
  const results = await Promise.allSettled(
    LANDINGS.map(async (landing) => {
      const html = await fetchPage(landing.url);
      const parsed = parseTablePage(html);
      return { name: landing.name, website: landing.website, data: parsed };
    })
  );

  const landings = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`Failed: ${LANDINGS[i].name} - ${r.reason?.message}`);
    return { name: LANDINGS[i].name, website: LANDINGS[i].website, error: r.reason?.message || 'fetch failed' };
  });

  // Merge extra-date entries as extra landing records
  const extras = [];
  for (const l of landings) {
    if (l.data?.extraEntries?.length) {
      const byDate = {};
      for (const e of l.data.extraEntries) (byDate[e.date] ||= []).push(e);
      for (const [date, entries] of Object.entries(byDate)) {
        extras.push({ name: l.name, website: l.website, data: { date, entries, dockTotals: null } });
      }
      delete l.data.extraEntries;
    }
  }
  landings.push(...extras);

  const output = { fetchedAt: new Date().toISOString(), landings };

  // Ensure output dirs
  const dataDir = path.join(__dirname, 'docs', 'data');
  const historyDir = path.join(dataDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  // Write latest
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(output, null, 2));

  // Write per-source-date history snapshot
  const sourceDate = landings.find(l => l.data?.date)?.data?.date;
  if (sourceDate) {
    fs.writeFileSync(path.join(historyDir, `${sourceDate}.json`), JSON.stringify(output, null, 2));
    console.log(`Wrote docs/data/latest.json and docs/data/history/${sourceDate}.json`);
  } else {
    console.log('Wrote docs/data/latest.json (no source date detected)');
  }

  // Write dates index so the static frontend knows which history files exist
  const existingDates = fs.readdirSync(historyDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
  fs.writeFileSync(path.join(dataDir, 'dates.json'), JSON.stringify({ dates: existingDates }, null, 2));
  console.log(`Updated docs/data/dates.json with ${existingDates.length} dates`);
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
