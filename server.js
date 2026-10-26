import { Database } from "bun:sqlite";

const db = new Database(import.meta.dir + "/slothlog.db", { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
db.run(`CREATE TABLE IF NOT EXISTS visits (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  in_at TEXT NOT NULL,
  out_at TEXT,
  PRIMARY KEY (person_id, day)
)`);

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const day = (d = new Date()) => d.toLocaleDateString("en-CA");
const json = (data, status = 200) => Response.json(data, { status });
const body = async (req) => req.json().catch(() => ({}));

function state() {
  const today = day();
  const people = db.query(`SELECT p.id, p.name, v.in_at, v.out_at
    FROM people p LEFT JOIN visits v ON v.person_id = p.id AND v.day = ?
    ORDER BY p.name`).all(today);
  const week = db.query(`SELECT person_id, day, in_at, out_at FROM visits
    WHERE day >= date(?, '-6 days')`).all(today);
  const minutes = week.reduce((sum, v) => sum + (v.out_at ? (Date.parse(v.out_at) - Date.parse(v.in_at)) / 60000 : 0), 0);
  return { today, people, week: { checkins: week.length, minutes: Math.round(minutes) } };
}

async function model() {
  if (process.env.OLLAMA_MODEL) return process.env.OLLAMA_MODEL;
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
    return tags.models?.[0]?.name || "llama3.2:1b";
  } catch {
    return "llama3.2:1b";
  }
}

function fallback({ people, week }) {
  const here = people.filter((p) => p.in_at && !p.out_at).map((p) => p.name);
  const rest = here.length ? `${here.join(" and ")} ${here.length > 1 ? "are" : "is"} still checked in.` : "Everyone has clocked out.";
  return `This week logged ${week.checkins} check-ins and ${week.minutes} minutes together. ${rest} Tomorrow, pick one small thing to skip and let this log handle the rest.`;
}

async function recap() {
  const s = state();
  if (!s.people.length) return { text: "Nothing logged yet. Add one name, take one tap, and come back when the week has something to say.", model: null, ai: false, note: "Add someone first." };
  const name = await model();
  const context = s.people.map((p) => {
    const rows = db.query("SELECT day, in_at, out_at FROM visits WHERE person_id = ? AND day >= date(?, '-6 days') ORDER BY day").all(p.id, s.today);
    return `${p.name}: ${rows.length ? rows.map((r) => `${r.day} ${r.in_at.slice(11, 16)}-${r.out_at?.slice(11, 16) || "open"}`).join(", ") : "no visits"}`;
  }).join("\n");

  const counts = s.people.map((p) => ({
    name: p.name,
    count: db.query("SELECT COUNT(*) AS n FROM visits WHERE person_id = ? AND day >= date(?, '-6 days')").get(p.id, s.today).n,
  })).sort((a, b) => b.count - a.count);
  const top = counts[0];

  const prompt = `You are a calm sloth assistant. Attendance for the last 7 days:
${context}
Total: ${s.week.checkins} check-ins, ${s.week.minutes} minutes. Most consistent: ${top.name} (${top.count} visits).
Write exactly two short sentences, under 45 words. First sentence: a warm observation that names ${top.name} and mentions one real number from the data. Second sentence: one gentle, specific suggestion that makes tomorrow lazier. No markdown, no emoji.`;
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, prompt, stream: false, options: { temperature: 0.4, num_predict: 90 } }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const text = data.response?.trim();
    if (!text) throw new Error("empty response");
    return { text, model: name, ai: true, local: !name.endsWith(":cloud") };
  } catch (error) {
    return { text: fallback(s), model: null, ai: false, note: `Ollama unavailable (${error.message}). Using the built-in recap.` };
  }
}

async function api(req, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return json(state());

  if (req.method === "POST" && url.pathname === "/api/people") {
    const { name } = await body(req);
    const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!clean) return json({ error: "Name is required." }, 400);
    try {
      db.query("INSERT INTO people (name) VALUES (?)").run(clean);
      return json(state(), 201);
    } catch {
      return json({ error: "That name is already on the list." }, 409);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/checkin") {
    const { personId } = await body(req);
    if (!Number.isInteger(personId)) return json({ error: "Pick a person first." }, 400);
    if (!db.query("SELECT id FROM people WHERE id = ?").get(personId)) return json({ error: "That person is not on the list." }, 404);
    const today = day();
    const current = db.query("SELECT * FROM visits WHERE person_id = ? AND day = ?").get(personId, today);
    if (current) return json({ error: current.out_at ? "Already finished for today." : "Already checked in." }, 409);
    db.query("INSERT INTO visits (person_id, day, in_at) VALUES (?, ?, ?)").run(personId, today, new Date().toISOString());
    return json(state());
  }

  if (req.method === "POST" && url.pathname === "/api/checkout") {
    const { personId } = await body(req);
    if (!Number.isInteger(personId)) return json({ error: "Pick a person first." }, 400);
    const result = db.query("UPDATE visits SET out_at = ? WHERE person_id = ? AND day = ? AND out_at IS NULL")
      .run(new Date().toISOString(), personId, day());
    if (!result.changes) return json({ error: "No open check-in for today." }, 409);
    return json(state());
  }

  if (req.method === "POST" && url.pathname === "/api/recap") return json(await recap());

  return json({ error: "Not found." }, 404);
}

Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return api(req, url);
    if (url.pathname === "/") return new Response(Bun.file(import.meta.dir + "/public/index.html"));
    return new Response("Not found.", { status: 404 });
  },
});

console.log(`SlothLog is napping on http://localhost:${process.env.PORT || 3000}`);
