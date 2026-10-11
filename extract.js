// Fetches a web page and returns its readable text.
// Only public http(s) addresses are allowed, so the page cannot be used to
// reach services on your own machine or network.

const dns = require("dns").promises;
const net = require("net");

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
function isPrivateIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1") return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m) return isPrivateIPv4(m[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

async function guardedFetch(urlStr, hops = 0) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw Object.assign(new Error("That is not a valid URL."), { status: 400 }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("Only http and https links are supported."), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw Object.assign(new Error("Could not find that site."), { status: 502 }); });
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) throw Object.assign(new Error("That address is not allowed."), { status: 400 });
  const res = await fetch(u, {
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ReadAloud/1.0)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    if (hops >= 4) throw Object.assign(new Error("Too many redirects."), { status: 502 });
    return guardedFetch(new URL(res.headers.get("location"), u).href, hops + 1);
  }
  return res;
}

async function readLimited(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > limit) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return ""; }
    }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}

function htmlToText(html) {
  let title = "";
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  title = decode((og && og[1]) || (tt && tt[1]) || "").replace(/\s+/g, " ").trim();

  let h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|button|select|template)\b[\s\S]*?<\/\1>/gi, " ");

  // Prefer the longest <article>, then <main>, else the whole body.
  const pick = (tag) => {
    const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi");
    let best = "", m;
    while ((m = re.exec(h))) if (m[1].length > best.length) best = m[1];
    return best;
  };
  const body = pick("article") || pick("main") || (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h) || [0, h])[1];

  const text = decode(
    body
      .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
      .replace(/<\/(h[1-6])>/gi, "\n\n")
      .replace(/<\/(p|div|section|li|tr|blockquote|pre|figure|figcaption|ul|ol|table)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );

  const paras = text.split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 3);
  return { title, text: paras.join("\n\n") };
}

async function extract(urlStr) {
  const res = await guardedFetch(urlStr);
  if (!res.ok) throw Object.assign(new Error("The site answered with " + res.status + "."), { status: 502 });
  const type = res.headers.get("content-type") || "";
  const buf = await readLimited(res, 2 * 1024 * 1024);
  const cs = (/charset=([\w-]+)/i.exec(type) || [])[1] || "utf-8";
  let raw;
  try { raw = new TextDecoder(cs).decode(buf); } catch (_) { raw = buf.toString("utf8"); }
  if (/text\/plain/i.test(type)) return { title: "", text: raw.trim() };
  if (!/html|xml/i.test(type) && !/^\s*</.test(raw)) throw Object.assign(new Error("That link is not a web page or text file."), { status: 415 });
  const out = htmlToText(raw);
  if (!out.text) throw Object.assign(new Error("No readable text found on that page."), { status: 422 });
  return out;
}

module.exports = { extract, htmlToText, isPrivateIP };
