// Local server: serves the reader page and forwards text to the speech
// provider you pick. API keys stay on this machine.
// Requires Node 18+ (built-in fetch). No npm packages.

const http = require("http");
const fs = require("fs");
const path = require("path");

// Minimal .env loader (KEY=VALUE per line).
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (_) {}

const { PROVIDERS, keyFor } = require("./providers");
const { extract } = require("./extract");

const PORT = Number(process.env.PORT) || 3000;
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
const fail = (res, status, message) => sendJson(res, status, { error: { message } });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleTts(req, res) {
  let input;
  try { input = JSON.parse(await readBody(req)); }
  catch (_) { return fail(res, 400, "Body must be valid JSON."); }

  const p = PROVIDERS[input.provider];
  if (!p) return fail(res, 400, "Unknown provider.");
  const key = keyFor(input.provider);
  if (!key) return fail(res, 500, `${p.keyVar} is not set on the server. Add it to .env and restart.`);

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return fail(res, 400, "text is required.");
  if (text.length > p.maxChars) return fail(res, 400, `text is over ${p.maxChars} characters.`);
  const model = typeof input.model === "string" ? input.model : "";
  if (model && !p.okModel(model)) return fail(res, 400, "Unknown model.");
  const voice = typeof input.voice === "string" ? input.voice.trim().slice(0, 80) : "";
  const options = input.options && typeof input.options === "object" ? input.options : {};

  let up;
  try { up = p.build(key, { text, model, voice, options }); }
  catch (e) { return fail(res, e.status || 400, e.message); }

  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
  try {
    const r = await fetch(up.url, { method: "POST", headers: up.headers, body: up.body, signal: ctrl.signal });
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (!r.body) return res.end();
    for await (const chunk of r.body) res.write(chunk); // pass audio through as it arrives
    res.end();
  } catch (e) {
    if (ctrl.signal.aborted) return;
    if (!res.headersSent) fail(res, 502, `Could not reach ${p.label}: ${e.message}`);
    else res.end();
  }
}

const server = http.createServer(async (req, res) => {
  // Refuse requests whose Host is not localhost (guards against DNS rebinding).
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  const u = new URL(req.url || "/", "http://localhost");
  const route = u.pathname;

  try {
    if (req.method === "GET" && STATIC[route]) {
      const [file, type] = STATIC[route];
      const buf = await fs.promises.readFile(path.join(__dirname, "public", file));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      return res.end(buf);
    }
    if (req.method === "GET" && route === "/api/providers") {
      return sendJson(res, 200, Object.entries(PROVIDERS).map(([id, p]) => ({
        id, label: p.label, keyVar: p.keyVar, configured: Boolean(keyFor(id)), maxChars: p.maxChars,
      })));
    }
    if (req.method === "GET" && route === "/api/catalog") {
      const id = u.searchParams.get("provider");
      const p = PROVIDERS[id];
      if (!p) return fail(res, 400, "Unknown provider.");
      try { return sendJson(res, 200, await p.catalog(keyFor(id))); }
      catch (e) { return fail(res, 502, e.message); }
    }
    if (req.method === "GET" && route === "/api/extract") {
      try { return sendJson(res, 200, await extract(u.searchParams.get("url") || "")); }
      catch (e) { return fail(res, e.status || 502, e.message); }
    }
    if (req.method === "POST" && route === "/api/tts") return handleTts(req, res);
  } catch (e) {
    if (!res.headersSent) return fail(res, 500, "Server error.");
    return res.end();
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Read Aloud running at http://localhost:${PORT}`);
  const on = Object.entries(PROVIDERS).filter(([id]) => keyFor(id)).map(([, p]) => p.label);
  console.log(on.length ? "Providers with keys: " + on.join(", ") : "No provider keys found. Browser voices still work; add keys to .env for the rest.");
});
