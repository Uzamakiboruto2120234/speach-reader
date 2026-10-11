(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reader = $("reader"), textEl = $("text"), statusEl = $("status"), playBtn = $("play"), playIco = $("play-ico");

  const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  const MAX_UNIT = 400, MIN_UNIT = 120, MAX_SENT = 1800;
  const synth = window.speechSynthesis || null;
  const hasBrowserTTS = Boolean(synth && window.SpeechSynthesisUtterance);

  const SAMPLE =
    "Reading aloud is a good way to catch what your eyes skip over. A clumsy sentence is easy to hear and hard to see.\n\n" +
    "Pick a voice provider in the Voice panel. Browser voices are free and work without a key. The others need an API key in the server's .env file.\n\n" +
    "Click any sentence to start from there. Use the speed slider to listen faster, and set a sleep timer if you like to listen in bed.";

  /* ---------- settings ---------- */
  const store = {
    get(k) { try { return localStorage.getItem("readaloud." + k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem("readaloud." + k, v); } catch (_) {} },
  };
  let S = { provider: "", speed: 1, theme: "system", clean: true, p: {} };
  try { Object.assign(S, JSON.parse(store.get("settings") || "{}")); } catch (_) {}
  const saveSettings = () => store.set("settings", JSON.stringify(S));
  const P = () => (S.p[S.provider] = S.p[S.provider] || {});

  /* ---------- state ---------- */
  let sentences = [], spans = [], units = [];
  let totalWords = 0, totalChars = 0;
  let uIdx = 0, state = "idle", token = 0, once = false, resumable = false;
  let providers = [], catalog = null, catalogSeq = 0;
  const cache = new Map();
  const audio = new Audio();
  audio.preservesPitch = true;
  const timers = {};

  const later = (k, fn, ms) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const countWords = (t) => (t.match(/\S+/g) || []).length;
  const fmtSpeed = (v) => Number(v).toFixed(2).replace(/0$/, "") + "×";
  function setStatus(s, err) { statusEl.textContent = s; statusEl.className = "status" + (err ? " err" : ""); }
  function setProgress(f) { $("prog").style.width = clamp(f, 0, 1) * 100 + "%"; }
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); }

  /* ---------- text preparation ---------- */
  function cleanMarkdown(t) {
    return t
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      // Headings and list items get a full stop so each is read as its own sentence.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]*(.+?)[ \t]*#*[ \t]*$/gm, (m, t) => (/[.!?:;,।]$/.test(t) ? t : t + "."))
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/gm, (m, t) => (/[.!?:;,।]$/.test(t) ? t : t + "."))
      .replace(/^\s*[-=*_]{3,}\s*$/gm, "")
      .replace(/(\*\*|~~|`|\*)/g, "")
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1$2")
      .replace(/\|/g, " ");
  }

  function splitSentences(para) {
    const out = [];
    if (window.Intl && Intl.Segmenter) {
      for (const s of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(para)) { const t = s.segment.trim(); if (t) out.push(t); }
    } else {
      (para.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) || [para]).forEach((s) => { const t = s.trim(); if (t) out.push(t); });
    }
    const res = [];
    for (let t of out) {
      while (t.length > MAX_SENT) {
        let cut = t.lastIndexOf(" ", MAX_SENT); if (cut < 1) cut = MAX_SENT;
        res.push(t.slice(0, cut).trim()); t = t.slice(cut).trim();
      }
      if (t) res.push(t);
    }
    return res;
  }

  let initialParse = true;
  function parse() {
    let raw = textEl.value.replace(/\r/g, "");
    if (S.clean) raw = cleanMarkdown(raw);
    const paras = raw.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
    sentences = []; spans = []; units = []; totalWords = 0; totalChars = 0; active = -1; wordIdx = -1;
    reader.textContent = "";
    if (!paras.length) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "Nothing to read yet. Paste some text, open a file or load a web page.";
      reader.appendChild(e); updateMeta(); setStatus("Ready"); setProgress(0); return;
    }
    paras.forEach((p, pi) => {
      const pe = document.createElement("p");
      splitSentences(p).forEach((t, k) => {
        const i = sentences.length;
        sentences.push({ text: t, words: countWords(t), para: pi, before: totalWords });
        totalWords += sentences[i].words; totalChars += t.length;
        if (k > 0) pe.appendChild(document.createTextNode(" "));
        const sp = document.createElement("span");
        sp.className = "s"; sp.textContent = t; sp.dataset.i = i; sp.tabIndex = 0; sp.setAttribute("role", "button");
        spans.push(sp); pe.appendChild(sp);
      });
      reader.appendChild(pe);
    });
    // Group short neighbouring sentences (same paragraph) into one request.
    let cur = null;
    sentences.forEach((s, i) => {
      if (cur && cur.para === s.para && cur.text.length < MIN_UNIT && cur.text.length + s.text.length + 1 <= MAX_UNIT) {
        cur.starts.push(cur.text.length + 1); cur.text += " " + s.text; cur.idx.push(i); cur.words += s.words;
      } else {
        cur = { text: s.text, idx: [i], starts: [0], para: s.para, words: s.words, before: s.before };
        units.push(cur);
      }
    });
    units.forEach((u, n) => u.idx.forEach((i) => { sentences[i].unit = n; }));

    uIdx = 0;
    if (initialParse) {
      try {
        const r = JSON.parse(store.get("resume") || "null");
        if (r && r.h === hash(textEl.value) && sentences[r.s]) uIdx = sentences[r.s].unit;
      } catch (_) {}
    }
    updateMeta();
    if (uIdx > 0) { markUnit(uIdx, "grp"); setStatus(`Resume from passage ${uIdx + 1} of ${units.length}. Press play.`); }
    else setStatus("Ready");
    setProgress(units[uIdx] ? units[uIdx].before / Math.max(1, totalWords) : 0);
    initialParse = false;
  }
  function updateMeta() {
    $("count").textContent = totalWords.toLocaleString() + " words · " + totalChars.toLocaleString() + " characters";
    $("save-hint").textContent = isBrowser() ? "Not available for browser voices."
      : `Generates all ${units.length} passages (${totalChars.toLocaleString()} characters), then downloads one file.`;
  }
  const saveResume = () => { if (sentences.length && units[uIdx]) store.set("resume", JSON.stringify({ h: hash(textEl.value), s: units[uIdx].idx[0] })); };

  /* ---------- highlighting ---------- */
  let active = -1, wordIdx = -1, shown = [];
  function keepVisible(el) {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = calm ? "auto" : "smooth";
    const r = el.getBoundingClientRect();
    if (reader.scrollHeight > reader.clientHeight + 4) {
      const rr = reader.getBoundingClientRect();
      if (r.top < rr.top + 40 || r.bottom > rr.bottom - 40) reader.scrollTo({ top: reader.scrollTop + (r.top - rr.top) - rr.height / 3, behavior });
    } else if (r.top < 80 || r.bottom > innerHeight - 190) el.scrollIntoView({ block: "center", behavior });
  }
  function clearWord() { if (wordIdx >= 0 && spans[wordIdx]) spans[wordIdx].textContent = sentences[wordIdx].text; wordIdx = -1; }
  function setActive(i) {
    if (i === active) return;
    clearWord();
    if (active >= 0 && spans[active]) spans[active].classList.remove("now");
    active = i;
    if (i >= 0 && spans[i]) { spans[i].classList.add("now"); keepVisible(spans[i]); }
  }
  function markUnit(n, mode) {
    clearWord();
    shown.forEach((i) => spans[i] && spans[i].classList.remove("grp", "wait", "now"));
    shown = []; active = -1;
    if (n < 0 || !units[n]) return;
    units[n].idx.forEach((i) => { spans[i].classList.add(mode === "wait" ? "wait" : "grp"); shown.push(i); });
    if (mode === "play") setActive(units[n].idx[0]);
    else keepVisible(spans[units[n].idx[0]]);
  }
  function markWord(i, ci, len) {
    const t = sentences[i].text, s = spans[i];
    if (!len) { const m = /\S+/.exec(t.slice(ci)); if (!m) return; ci += m.index; len = m[0].length; }
    clearWord();
    s.textContent = "";
    s.append(t.slice(0, ci));
    const mk = document.createElement("mark"); mk.textContent = t.slice(ci, ci + len);
    s.append(mk, t.slice(ci + len));
    wordIdx = i;
  }

  /* ---------- providers and voices ---------- */
  const isBrowser = () => S.provider === "browser";
  const curModel = () => (catalog && catalog.models || []).find((m) => m.id === P().model) || null;
  const voiceList = () => { const m = curModel(); return (m && m.voices) || (catalog && catalog.voices) || []; };

  function browserCatalog() {
    const lang = (navigator.language || "en-US").toLowerCase(), base = lang.split("-")[0];
    const rank = (v) => { const l = v.lang.toLowerCase(); return l === lang ? 0 : l.split(/[-_]/)[0] === base ? 1 : 2; };
    const vs = (synth ? synth.getVoices() : []).slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return {
      models: [], voices: vs.map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` })),
      defaultVoice: vs[0] ? vs[0].voiceURI : "", controls: [],
      note: "Free voices built into your browser and operating system. They work offline and highlight each word.",
    };
  }

  function fillSelect(sel, items, value, withDefault) {
    sel.textContent = "";
    if (withDefault) { const o = document.createElement("option"); o.value = ""; o.textContent = "Default"; sel.appendChild(o); }
    const groups = new Map();
    items.forEach((it) => {
      const g = it.group || "";
      if (!groups.has(g)) { const parent = g ? document.createElement("optgroup") : sel; if (g) { parent.label = g; sel.appendChild(parent); } groups.set(g, parent); }
      const o = document.createElement("option"); o.value = it.id; o.textContent = it.label;
      groups.get(g).appendChild(o);
    });
    sel.value = value;
    if (sel.value !== value) sel.selectedIndex = 0;
  }

  function renderProviders() {
    const box = $("providers"); box.textContent = "";
    const list = [];
    if (hasBrowserTTS) list.push({ id: "browser", label: "Browser (free)", configured: true });
    providers.forEach((p) => list.push(p));
    list.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.dataset.id = p.id;
      b.setAttribute("aria-checked", String(p.id === S.provider));
      b.textContent = p.label + (p.configured ? "" : " ·  no key");
      b.addEventListener("click", () => selectProvider(p.id));
      box.appendChild(b);
    });
  }

  function renderVoicePanel() {
    const note = $("prov-note"), p = providers.find((x) => x.id === S.provider);
    note.textContent = "";
    note.className = "note";
    if (p && !p.configured) {
      note.className = "note warn";
      note.append("No key found. Add ");
      const c = document.createElement("code"); c.textContent = p.keyVar; note.append(c, " to .env and restart the server.");
      note.hidden = false;
    } else if (catalog && catalog.note) { note.textContent = catalog.note; note.hidden = false; }
    else note.hidden = true;
    if (!catalog) { ["f-model", "f-lang", "f-voice", "f-custom", "f-var", "f-stab", "f-instr"].forEach((id) => { $(id).hidden = true; }); return; }

    const st = P(), models = catalog.models || [];
    if (!models.some((m) => m.id === st.model)) st.model = catalog.defaultModel || (models[0] && models[0].id) || "";
    $("f-model").hidden = models.length < 2;
    if (models.length >= 2) fillSelect($("model"), models.map((m) => ({ id: m.id, label: m.label })), st.model);

    const m = curModel(), vs = voiceList();
    const dflt = m && m.defaultVoice !== undefined ? m.defaultVoice : (catalog.defaultVoice !== undefined ? catalog.defaultVoice : (vs[0] ? vs[0].id : ""));
    if (st.voice === undefined || (st.voice !== "" && !vs.some((v) => v.id === st.voice))) st.voice = dflt;
    $("f-voice").hidden = false;
    fillSelect($("voice"), vs, st.voice, dflt === "");
    $("f-custom").hidden = isBrowser();
    $("custom").value = st.custom || "";

    const ctl = catalog.controls || [];
    $("f-lang").hidden = !ctl.includes("language");
    if (ctl.includes("language")) {
      if (!st.lang) st.lang = "en-IN";
      fillSelect($("lang"), catalog.languages, st.lang);
    }
    const isV2 = st.model === "bulbul:v2";
    $("f-var").hidden = !(ctl.includes("variation") && !isV2);
    $("variation").value = st.variation != null ? st.variation : 0.6; $("variation-o").textContent = Number($("variation").value).toFixed(2);
    $("f-stab").hidden = !ctl.includes("stability");
    $("stability").value = st.stability != null ? st.stability : 0.5; $("stability-o").textContent = Number($("stability").value).toFixed(2);
    $("f-instr").hidden = !(ctl.includes("instructions") && m && m.instructions);
    $("instr").value = st.instr || "";
    $("save").disabled = isBrowser();
    updateMeta();
    saveSettings();
  }

  async function loadCatalog() {
    const seq = ++catalogSeq;
    catalog = null; renderVoicePanel();
    if (isBrowser()) { catalog = browserCatalog(); renderVoicePanel(); return; }
    try {
      const r = await fetch("/api/catalog?provider=" + encodeURIComponent(S.provider));
      const j = await r.json();
      if (seq !== catalogSeq) return;
      if (!r.ok) throw new Error((j.error && j.error.message) || "Could not load voices.");
      catalog = j; renderVoicePanel();
    } catch (e) {
      if (seq !== catalogSeq) return;
      const note = $("prov-note");
      note.className = "note warn"; note.textContent = e.message; note.hidden = false;
    }
  }

  function selectProvider(id) {
    if (id === S.provider) return;
    softStop(); clearCache();
    S.provider = id; saveSettings(); renderProviders(); loadCatalog();
  }

  function voiceId() { const st = P(); return (st.custom || "").trim() || st.voice || ""; }
  function requestBody(text) {
    const st = P();
    return {
      provider: S.provider, text, model: st.model || "", voice: voiceId(),
      options: { language: st.lang, variation: st.variation, stability: st.stability, instructions: st.instr },
    };
  }
  function onVoiceChange() {
    const st = P();
    if (!$("f-model").hidden) st.model = $("model").value;
    st.voice = $("voice").value; st.custom = $("custom").value;
    if (!$("f-lang").hidden) st.lang = $("lang").value;
    st.variation = parseFloat($("variation").value); st.stability = parseFloat($("stability").value); st.instr = $("instr").value;
    $("variation-o").textContent = st.variation.toFixed(2); $("stability-o").textContent = st.stability.toFixed(2);
    saveSettings(); clearCache();
    if (state === "playing" || state === "loading") later("restart", () => startAt(uIdx), 500);
  }

  /* ---------- audio fetching ---------- */
  function clearCache() { cache.forEach((p) => p.then((u) => URL.revokeObjectURL(u), () => {})); cache.clear(); }
  function errorMessage(res, text) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = JSON.parse(text);
      const d = j.detail;
      msg = (j.error && (j.error.message || (typeof j.error === "string" && j.error))) || j.err_msg || (d && d.message) ||
        (Array.isArray(d) && d[0] && d[0].msg) || (typeof d === "string" && d) || j.message || msg;
    } catch (_) {}
    return msg;
  }
  function getAudio(n) {
    const u = units[n]; if (!u) return null;
    const body = JSON.stringify(requestBody(u.text));
    if (cache.has(body)) return cache.get(body);
    const p = fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body }).then(async (res) => {
      if (res.ok) return URL.createObjectURL(await res.blob());
      throw new Error(errorMessage(res, await res.text()));
    });
    p.catch(() => cache.delete(body));
    cache.set(body, p);
    return p;
  }
  function prefetch(n) { for (let k = n; k < n + 2 && k < units.length; k++) { const p = getAudio(k); if (p) p.catch(() => {}); } }

  /* ---------- playback ---------- */
  function setState(s) {
    state = s;
    const on = s === "playing" || s === "loading";
    playIco.innerHTML = on ? PAUSE : PLAY;
    playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  }
  const where = (n) => `Passage ${n + 1} of ${units.length}`;
  function haltEngines() { audio.pause(); if (synth) synth.cancel(); }

  function startAt(n, preview) {
    if (!units.length) return;
    n = clamp(n, 0, units.length - 1);
    token++; const my = token;
    once = Boolean(preview); resumable = false;
    haltEngines(); uIdx = n; saveResume();
    if (isBrowser()) return speakBrowser(n, my);
    setState("loading"); markUnit(n, "wait"); setStatus(`Generating ${where(n).toLowerCase()}…`);
    getAudio(n).then((url) => {
      if (my !== token) return;
      audio.src = url; audio.defaultPlaybackRate = S.speed; audio.playbackRate = S.speed; audio.volume = 1;
      return audio.play().then(() => {
        if (my !== token) return;
        setState("playing"); markUnit(n, "play"); resumable = true; setStatus(where(n));
        if (!once) prefetch(n + 1);
      });
    }).catch((e) => { if (my !== token) return; setState("idle"); markUnit(-1); setStatus(e && e.message ? e.message : "Playback failed.", true); });
  }

  function speakBrowser(n, my) {
    const u = units[n], ut = new SpeechSynthesisUtterance(u.text);
    const v = synth.getVoices().find((x) => x.voiceURI === voiceId());
    if (v) { ut.voice = v; ut.lang = v.lang; }
    ut.rate = clamp(S.speed, 0.5, 2.5);
    ut.onboundary = (e) => {
      if (my !== token || (e.name && e.name !== "word")) return;
      let k = 0; while (k + 1 < u.starts.length && u.starts[k + 1] <= e.charIndex) k++;
      const i = u.idx[k]; setActive(i);
      markWord(i, e.charIndex - u.starts[k], e.charLength);
      const frac = e.charIndex / Math.max(1, u.text.length);
      setProgress((u.before + u.words * frac) / Math.max(1, totalWords));
    };
    ut.onend = () => { if (my === token) advance(); };
    ut.onerror = (e) => {
      if (my !== token || e.error === "canceled" || e.error === "interrupted") return;
      setState("idle"); setStatus("Speech failed (" + e.error + "). Try another voice.", true);
    };
    setState("playing"); markUnit(n, "play"); setStatus(where(n));
    setTimeout(() => { if (my === token) synth.speak(ut); }, 60);
  }

  function advance() {
    if (once) { softStop(); return; }
    const next = uIdx + 1;
    if (next >= units.length) { finish(); return; }
    if (sleep.para && units[next].para !== units[uIdx].para) {
      sleep.para = false; $("sleep").value = "0"; sleepUi();
      token++; haltEngines(); uIdx = next; saveResume(); setState("paused"); resumable = false;
      markUnit(next, "grp"); setStatus("Sleep timer: stopped at the end of the paragraph."); return;
    }
    startAt(next);
  }
  function finish() { token++; setState("idle"); markUnit(-1); uIdx = 0; resumable = false; setProgress(1); setStatus("Finished"); store.set("resume", "null"); }
  function pause() { token++; haltEngines(); setState("paused"); setStatus(`Paused · ${where(uIdx)}`); }
  function resume() {
    if (!isBrowser() && resumable && audio.src && audio.paused) {
      token++; const my = token;
      audio.play().then(() => { if (my === token) { setState("playing"); setStatus(where(uIdx)); } }).catch(() => startAt(uIdx));
    } else startAt(uIdx);
  }
  function stopAll(msg) {
    token++; haltEngines(); audio.removeAttribute("src"); resumable = false; once = false;
    setState("idle"); markUnit(-1); uIdx = 0; setProgress(0); setStatus(msg || "Stopped");
  }
  // Stop playing but keep the current position (used after a preview and when switching voice).
  function softStop() {
    token++; haltEngines(); audio.removeAttribute("src"); resumable = false; once = false;
    setState("idle");
    if (units[uIdx]) { markUnit(uIdx, "grp"); setStatus(`Ready · ${where(uIdx)}`); } else setStatus("Ready");
  }
  const toggle = () => { if (state === "playing" || state === "loading") pause(); else if (state === "paused") resume(); else startAt(uIdx); };
  function jump(d) {
    if (!units.length) return;
    const n = clamp(uIdx + d, 0, units.length - 1);
    if (state === "playing" || state === "loading") startAt(n);
    else { token++; haltEngines(); resumable = false; uIdx = n; setState("idle"); markUnit(n, "grp"); setStatus(where(n)); setProgress(units[n].before / Math.max(1, totalWords)); saveResume(); }
  }

  audio.addEventListener("ended", () => { if (state === "playing") advance(); });
  audio.addEventListener("timeupdate", () => {
    const u = units[uIdx]; if (isBrowser() || !u || !audio.duration || state !== "playing") return;
    const frac = audio.currentTime / audio.duration;
    const pos = frac * u.text.length;
    let k = 0; while (k + 1 < u.starts.length && u.starts[k + 1] <= pos) k++;
    setActive(u.idx[k]);
    setProgress((u.before + u.words * frac) / Math.max(1, totalWords));
    if (sleep.end) { const left = sleep.end - Date.now(); audio.volume = left < 5000 ? clamp(left / 5000, 0, 1) : 1; }
  });

  /* ---------- speed ---------- */
  function setSpeed(v, silent) {
    S.speed = clamp(Math.round(v * 20) / 20, 0.5, 2.5);
    $("speed").value = S.speed; $("speed-o").textContent = fmtSpeed(S.speed);
    audio.defaultPlaybackRate = S.speed; audio.playbackRate = S.speed;
    saveSettings();
    if (!silent && isBrowser() && state === "playing") later("rate", () => startAt(uIdx), 400);
  }

  /* ---------- sleep timer ---------- */
  const sleep = { end: 0, para: false, iv: 0 };
  function sleepUi() {
    const out = $("sleep-o");
    if (sleep.end) { const s = Math.max(0, Math.round((sleep.end - Date.now()) / 1000)); out.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    else out.textContent = "";
  }
  function sleepSet(v) {
    clearInterval(sleep.iv); sleep.end = 0; sleep.para = false; audio.volume = 1;
    if (v === "para") sleep.para = true;
    else if (Number(v) > 0) {
      sleep.end = Date.now() + Number(v) * 60000;
      sleep.iv = setInterval(() => {
        if (Date.now() >= sleep.end) {
          clearInterval(sleep.iv); sleep.end = 0; $("sleep").value = "0"; audio.volume = 1;
          if (state === "playing" || state === "loading") { pause(); setStatus("Sleep timer ended."); }
        }
        sleepUi();
      }, 1000);
    }
    sleepUi();
  }

  /* ---------- save as MP3 ---------- */
  let saving = false, cancelSave = false;
  async function saveAudio() {
    if (saving) { cancelSave = true; return; }
    if (isBrowser() || !units.length) return;
    saving = true; cancelSave = false; $("save").textContent = "Cancel";
    const parts = [];
    try {
      for (let n = 0; n < units.length; n++) {
        if (cancelSave) { setStatus("Save cancelled."); return; }
        setStatus(`Saving audio: passage ${n + 1} of ${units.length}…`);
        const url = await getAudio(n);
        parts.push(await (await fetch(url)).blob());
        setProgress((n + 1) / units.length);
      }
      const blob = new Blob(parts, { type: "audio/mpeg" });
      const name = (textEl.value.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).slice(0, 5).join("-") || "read-aloud").toLowerCase();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name + ".mp3";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`Saved ${name}.mp3`); setProgress(0);
    } catch (e) { setStatus(e.message || "Could not save audio.", true); }
    finally { saving = false; $("save").textContent = "Save as MP3"; }
  }

  /* ---------- text sources ---------- */
  function reset(t) {
    token++; haltEngines(); audio.removeAttribute("src"); resumable = false; once = false;
    setState("idle"); shown = []; clearCache();
    if (t !== undefined) textEl.value = t;
    store.set("text", textEl.value); store.set("resume", "null");
    parse();
  }
  function readFile(f) {
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => reset(String(fr.result || ""));
    fr.onerror = () => setStatus("Could not read that file.", true);
    fr.readAsText(f);
  }
  async function loadUrl(e) {
    e.preventDefault();
    const url = $("url").value.trim(); if (!url) return;
    const go = $("url-go"); go.disabled = true; setStatus("Loading the page…");
    try {
      const r = await fetch("/api/extract?url=" + encodeURIComponent(url));
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "Could not load that page.");
      reset((j.title ? j.title + "\n\n" : "") + j.text);
      $("url-row").hidden = true; $("open-url").setAttribute("aria-expanded", "false");
      setStatus(`Loaded ${totalWords.toLocaleString()} words from the page.`);
    } catch (err) { setStatus(err.message, true); }
    finally { go.disabled = false; }
  }

  /* ---------- theme ---------- */
  function applyTheme() {
    const root = document.documentElement;
    if (S.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", S.theme);
    $("theme").textContent = "Theme: " + S.theme;
  }

  /* ---------- wiring ---------- */
  playBtn.addEventListener("click", toggle);
  $("stop").addEventListener("click", () => stopAll("Stopped"));
  $("prev").addEventListener("click", () => jump(-1));
  $("next").addEventListener("click", () => jump(1));
  $("preview").addEventListener("click", () => { if (units.length) startAt(uIdx, true); });
  $("save").addEventListener("click", saveAudio);
  $("theme").addEventListener("click", () => { S.theme = { system: "light", light: "dark", dark: "system" }[S.theme] || "system"; applyTheme(); saveSettings(); });
  $("speed").addEventListener("input", (e) => setSpeed(parseFloat(e.target.value)));
  $("sleep").addEventListener("change", (e) => sleepSet(e.target.value));
  $("clean").addEventListener("change", (e) => { S.clean = e.target.checked; saveSettings(); reset(); });
  ["model", "voice", "lang", "variation", "stability"].forEach((id) => $(id).addEventListener("change", () => {
    if (id === "model") { const st = P(); st.model = $("model").value; st.voice = undefined; renderVoicePanel(); }
    onVoiceChange();
  }));
  ["variation", "stability", "custom", "instr"].forEach((id) => $(id).addEventListener("input", onVoiceChange));

  reader.addEventListener("click", (e) => { const s = e.target.closest(".s"); if (s) startAt(sentences[+s.dataset.i].unit); });
  reader.addEventListener("keydown", (e) => {
    const s = e.target.closest && e.target.closest(".s");
    if (s && e.key === "Enter") { e.preventDefault(); startAt(sentences[+s.dataset.i].unit); }
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select" || tag === "input" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " " && tag !== "button") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") jump(1);
    else if (e.key === "ArrowLeft") jump(-1);
    else if (e.key === "]") setSpeed(S.speed + 0.1);
    else if (e.key === "[") setSpeed(S.speed - 0.1);
  });

  textEl.addEventListener("input", () => {
    $("count").textContent = countWords(textEl.value).toLocaleString() + " words";
    later("parse", () => reset(), 300);
  });
  $("sample").addEventListener("click", () => reset(SAMPLE));
  $("clear").addEventListener("click", () => { reset(""); textEl.focus(); });
  $("open-file").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => { readFile(e.target.files[0]); e.target.value = ""; });
  $("open-url").addEventListener("click", () => {
    const row = $("url-row"); row.hidden = !row.hidden;
    $("open-url").setAttribute("aria-expanded", String(!row.hidden));
    if (!row.hidden) $("url").focus();
  });
  $("url-row").addEventListener("submit", loadUrl);
  ["dragenter", "dragover"].forEach((ev) => textEl.addEventListener(ev, (e) => { e.preventDefault(); textEl.classList.add("drop-on"); }));
  ["dragleave", "drop"].forEach((ev) => textEl.addEventListener(ev, () => textEl.classList.remove("drop-on")));
  textEl.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { e.preventDefault(); readFile(f); } });
  addEventListener("pagehide", () => { if (synth) synth.cancel(); });
  if (synth) {
    const refresh = () => { if (isBrowser() && !(catalog && catalog.voices && catalog.voices.length)) loadCatalog(); };
    if (synth.addEventListener) synth.addEventListener("voiceschanged", refresh); else synth.onvoiceschanged = refresh;
  }

  /* ---------- init ---------- */
  async function init() {
    applyTheme();
    $("clean").checked = S.clean;
    setSpeed(S.speed || 1, true);
    const saved = store.get("text");
    textEl.value = saved !== null && saved !== "" ? saved : SAMPLE;
    try { providers = await (await fetch("/api/providers")).json(); } catch (_) { providers = []; }
    const known = (id) => (id === "browser" && hasBrowserTTS) || providers.some((p) => p.id === id);
    if (!known(S.provider)) {
      const first = providers.find((p) => p.configured);
      S.provider = first ? first.id : hasBrowserTTS ? "browser" : (providers[0] ? providers[0].id : "");
    }
    parse();
    renderProviders();
    loadCatalog();
  }
  init();
})();
