const Database = require('better-sqlite3');
const path = require('path');

let db;

function initDb() {
  db = new Database(path.join(__dirname, 'data', 'fishcounts.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS fish_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      landing_name TEXT NOT NULL,
      boat TEXT NOT NULL,
      trip_type TEXT,
      anglers INTEGER,
      fish_species TEXT NOT NULL,
      fish_count INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, landing_name, boat, trip_type, fish_species)
    );

    CREATE INDEX IF NOT EXISTS idx_date ON fish_counts(date);
    CREATE INDEX IF NOT EXISTS idx_landing ON fish_counts(landing_name);
    CREATE INDEX IF NOT EXISTS idx_species ON fish_counts(fish_species);
  `);

  return db;
}

const insertBatch = (records) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fish_counts (date, landing_name, boat, trip_type, anglers, fish_species, fish_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(r.date, r.landingName, r.boat, r.tripType, r.anglers, r.species, r.count);
    }
  });

  transaction(records);
};

function storeLandingData(landings) {
  const records = [];
  for (const landing of landings) {
    if (!landing.data || !landing.data.date) continue;
    for (const entry of landing.data.entries) {
      for (const fc of entry.fishCounts) {
        records.push({
          date: landing.data.date,
          landingName: landing.name,
          boat: entry.boat,
          tripType: entry.tripType || '',
          anglers: entry.anglers || null,
          species: fc.species,
          count: fc.count,
        });
      }
    }
  }
  if (records.length > 0) {
    insertBatch(records);
  }
}

function getCountsByDate(date) {
  return db.prepare(`
    SELECT landing_name, boat, trip_type, anglers, fish_species, fish_count
    FROM fish_counts WHERE date = ? ORDER BY landing_name, boat, fish_species
  `).all(date);
}

function getRecentDates(limit = 30) {
  return db
    .prepare('SELECT DISTINCT date FROM fish_counts ORDER BY date DESC LIMIT ?')
    .all(limit)
    .map((r) => r.date);
}

function getSpeciesTrend(species, days = 30) {
  return db.prepare(`
    SELECT date, landing_name, SUM(fish_count) as total
    FROM fish_counts
    WHERE fish_species = ? AND date >= date('now', '-' || ? || ' days')
    GROUP BY date, landing_name
    ORDER BY date
  `).all(species, days);
}

function getAllSpecies() {
  return db
    .prepare('SELECT DISTINCT fish_species FROM fish_counts ORDER BY fish_species')
    .all()
    .map((r) => r.fish_species);
}

module.exports = { initDb, storeLandingData, getCountsByDate, getRecentDates, getSpeciesTrend, getAllSpecies };
