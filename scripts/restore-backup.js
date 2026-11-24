#!/usr/bin/env node
// Restore a BodyData backup (from GET /admin/backup) into a Postgres database.
//   node scripts/restore-backup.js <backup.ndjson.gz> <DATABASE_URL>
// Use an EMPTY database (a new Railway Postgres, or a local one to inspect). To bring the app back,
// point the API at the new database and start it once first, so tables get their keys and indexes.
// Tables are created from the saved column types if they don't exist; rows are inserted
// with ON CONFLICT DO NOTHING, and serial sequences are moved past the restored ids.
const fs = require("fs"), zlib = require("zlib"), readline = require("readline");
const { Pool } = require("pg");
const [file, url] = process.argv.slice(2);
if (!file || !url) { console.error("usage: restore-backup.js <backup.ndjson.gz> <DATABASE_URL>"); process.exit(1); }
const TYPE = { "timestamp with time zone": "TIMESTAMPTZ", "timestamp without time zone": "TIMESTAMP", "character varying": "TEXT" };
(async () => {
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const cols = {}, counts = {}; let batch = [], cur = null, expected = null;
  const flush = async () => {
    if (!batch.length) return;
    const names = cols[cur].map(c => c.column_name), vals = [], ph = [];
    for (const r of batch) {
      ph.push("(" + names.map((_, i) => `$${vals.length + i + 1}`).join(",") + ")");
      for (const c of cols[cur]) { const v = r[c.column_name]; vals.push(v != null && /json/.test(c.data_type) ? JSON.stringify(v) : v); }
    }
    const r = await pool.query(`INSERT INTO "${cur}" (${names.map(n => `"${n}"`).join(",")}) VALUES ${ph.join(",")} ON CONFLICT DO NOTHING`, vals);
    counts[cur] = (counts[cur] || 0) + r.rowCount; batch = [];
  };
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.table) {
      await flush(); cur = o.table; cols[cur] = o.columns; counts[cur] = 0;
      const defs = o.columns.map(c => `"${c.column_name}" ${TYPE[c.data_type] || c.data_type.toUpperCase()}`).join(", ");
      await pool.query(`CREATE TABLE IF NOT EXISTS "${cur}" (${defs})`);
    } else if (o.t) { batch.push(o.r); if (batch.length >= Math.max(1, Math.floor(30000 / cols[cur].length))) await flush(); }
    else if (o.end) { await flush(); expected = o.counts; }
  }
  await flush();
  const seqs = await pool.query(`SELECT table_name, column_name, pg_get_serial_sequence('"'||table_name||'"', column_name) seq FROM information_schema.columns WHERE table_schema='public' AND column_default LIKE 'nextval%'`);
  for (const s of seqs.rows) if (s.seq) await pool.query(`SELECT setval($1, GREATEST(COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 0), 1))`, [s.seq]);
  await pool.end();
  console.log("restored", JSON.stringify(counts));
  if (!expected) { console.error("⚠ backup file has no end marker: it's incomplete"); process.exit(2); }
  const short = Object.entries(expected).filter(([t, n]) => (counts[t] || 0) < n);
  if (short.length) console.warn("⚠ fewer rows than in the backup (already present?):", JSON.stringify(Object.fromEntries(short)));
})().catch(e => { console.error(e.message); process.exit(1); });
