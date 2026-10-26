import { Database } from "bun:sqlite";

const db = new Database(import.meta.dir + "/slothlog.db", { create: true });
db.run("CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
db.run(`CREATE TABLE IF NOT EXISTS visits (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  day TEXT NOT NULL, in_at TEXT NOT NULL, out_at TEXT,
  PRIMARY KEY (person_id, day)
)`);

const people = ["Maya", "Arjun", "Noor", "Theo"];
const names = Object.fromEntries(people.map((name) => [name, db.query("INSERT OR IGNORE INTO people (name) VALUES (?) RETURNING id").get(name)?.id || db.query("SELECT id FROM people WHERE name = ?").get(name).id]));
const localDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString("en-CA"); };
const at = (dayOffset, time) => new Date(`${localDay(dayOffset)}T${time}:00`).toISOString();
const pattern = [
  ["Maya", -5, "09:10", "13:20"], ["Arjun", -5, "10:05", "12:40"], ["Noor", -5, "09:30", "17:05"], ["Theo", -5, "11:15", "15:00"],
  ["Maya", -4, "09:05", "13:00"], ["Noor", -4, "09:45", "16:30"],
  ["Maya", -3, "09:20", "12:50"], ["Arjun", -3, "10:10", "13:15"], ["Theo", -3, "11:00", "14:20"],
  ["Maya", -2, "09:00", "12:30"], ["Noor", -2, "09:35", "16:45"], ["Theo", -2, "10:50", "14:05"],
  ["Maya", -1, "09:15", "12:40"], ["Arjun", -1, "10:00", "12:30"], ["Noor", -1, "09:40", "16:20"],
  ["Maya", 0, "09:05", null], ["Arjun", 0, "10:15", null], ["Noor", 0, "09:25", "12:55"],
];

for (const [name, offset, start, end] of pattern) {
  db.query("INSERT OR IGNORE INTO visits (person_id, day, in_at, out_at) VALUES (?, ?, ?, ?)")
    .run(names[name], localDay(offset), at(offset, start), end ? at(offset, end) : null);
}

console.log("Seeded 4 people and a week of slow attendance.");
