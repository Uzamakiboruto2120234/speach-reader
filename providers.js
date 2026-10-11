// Provider adapters. Each one turns a normalized request
//   { text, model, voice, options }
// into the upstream HTTP request, and describes its models and voices.
// Keys come from environment variables and never leave the server.

const env = (k, d) => (process.env[k] || d || "").replace(/\/$/, "");
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const idOk = (s) => typeof s === "string" && /^[\w.:-]{1,80}$/.test(s);

/* ---------------- Sarvam ---------------- */
const SARVAM_V3 = ["shubh","aditya","rahul","rohan","amit","dev","ratan","varun","manan","sumit","kabir","aayan","ashutosh","advait","anand","tarun","sunny","mani","gokul","vijay","mohit","rehan","soham","ritu","priya","neha","pooja","simran","kavya","ishita","shreya","roopa","tanya","shruti","suhani","kavitha","rupali"];
const SARVAM_V4 = ["aarti","aayan","advait","aditi","aditya","amelia","amit","anand","aparna","ashutosh","dev","gokul","ishita","kabir","kavitha","kavya","mani","manan","mohit","neha","pooja","priya","ratan","rehan","ritu","rohan","roopa","rupali","shreya","shruti","shubh","simran","soham","sumit","sunny","suhani","tanya","tarun","varun","vijay"];
const SARVAM_V2 = ["anushka","abhilash","manisha","vidya","arya","karun","hitesh"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const asVoices = (a) => a.map((n) => ({ id: n, label: cap(n) }));

const sarvam = {
  label: "Sarvam",
  keyVar: "SARVAM_API_KEY",
  maxChars: 3500,
  catalog: async () => ({
    models: [
      { id: "bulbul:v3", label: "Bulbul v3", voices: asVoices(SARVAM_V3), defaultVoice: "shubh" },
      { id: "bulbul:v4-flash", label: "Bulbul v4 Flash", voices: asVoices(SARVAM_V4), defaultVoice: "" },
      { id: "bulbul:v2", label: "Bulbul v2", voices: asVoices(SARVAM_V2), defaultVoice: "anushka" },
    ],
    defaultModel: "bulbul:v3",
    languages: [
      ["en-IN", "English (India)"], ["hi-IN", "Hindi"], ["bn-IN", "Bengali"], ["gu-IN", "Gujarati"],
      ["kn-IN", "Kannada"], ["ml-IN", "Malayalam"], ["mr-IN", "Marathi"], ["od-IN", "Odia"],
      ["pa-IN", "Punjabi"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"],
    ].map(([id, label]) => ({ id, label })),
    controls: ["language", "variation"],
    note: "Speaker IDs are lowercase. On v4 Flash, leave the voice empty for the default, or paste a full ID from Sarvam's voices page.",
  }),
  build(key, { text, model, voice, options }) {
    const m = model || "bulbul:v3";
    const body = { text, model: m, output_audio_codec: "mp3" };
    body.language_code = /^[a-z]{2}-IN$/.test(options.language) ? options.language : "en-IN";
    if (voice) body.speaker = voice.toLowerCase();
    if (m !== "bulbul:v2") { const t = num(options.variation, 0.01, 1); if (t !== undefined) body.temperature = t; }
    else body.enable_preprocessing = true;
    return {
      url: env("SARVAM_BASE_URL", "https://api.sarvam.ai") + "/text-to-speech/stream",
      headers: { "api-subscription-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },
  okModel: (m) => ["bulbul:v3", "bulbul:v4-flash", "bulbul:v2"].includes(m),
};

/* ---------------- OpenAI ---------------- */
const OPENAI_VOICES = ["alloy","ash","ballad","coral","echo","fable","onyx","nova","sage","shimmer","verse","marin","cedar"];
const openai = {
  label: "OpenAI",
  keyVar: "OPENAI_API_KEY",
  maxChars: 4096,
  catalog: async () => ({
    models: [
      { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", voices: asVoices(OPENAI_VOICES), defaultVoice: "coral", instructions: true },
      { id: "tts-1-hd", label: "TTS-1 HD", voices: asVoices(OPENAI_VOICES), defaultVoice: "alloy" },
      { id: "tts-1", label: "TTS-1 (fastest)", voices: asVoices(OPENAI_VOICES), defaultVoice: "alloy" },
    ],
    defaultModel: "gpt-4o-mini-tts",
    controls: ["instructions"],
    note: "Voices speak the language of the text. Instructions work with GPT-4o mini TTS only.",
  }),
  build(key, { text, model, voice, options }) {
    const m = model || "gpt-4o-mini-tts";
    const body = { model: m, voice: idOk(voice) ? voice : "coral", input: text, response_format: "mp3" };
    if (m.startsWith("gpt-4o-mini-tts") && typeof options.instructions === "string" && options.instructions.trim()) {
      body.instructions = options.instructions.trim().slice(0, 1000);
    }
    return {
      url: env("OPENAI_BASE_URL", "https://api.openai.com") + "/v1/audio/speech",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },
  okModel: (m) => ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"].includes(m),
};

/* ---------------- ElevenLabs ---------------- */
let elCache = { at: 0, data: null };
const elevenlabs = {
  label: "ElevenLabs",
  keyVar: "ELEVENLABS_API_KEY",
  maxChars: 5000,
  async catalog(key) {
    if (elCache.data && Date.now() - elCache.at < 10 * 60 * 1000) return elCache.data;
    const base = env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io");
    const h = { "xi-api-key": key };
    const mres = await fetch(base + "/v1/models", { headers: h });
    if (!mres.ok) throw new Error("ElevenLabs models request failed (" + mres.status + ")");
    const models = (await mres.json())
      .filter((m) => m.can_do_text_to_speech)
      .map((m) => ({ id: m.model_id, label: m.name || m.model_id, maxChars: m.maximum_text_length_per_request }));
    const voices = [];
    let token = null;
    for (let page = 0; page < 3; page++) {
      const u = new URL(base + "/v2/voices");
      u.searchParams.set("page_size", "100");
      u.searchParams.set("include_total_count", "false");
      if (token) u.searchParams.set("next_page_token", token);
      const vres = await fetch(u, { headers: h });
      if (!vres.ok) throw new Error("ElevenLabs voices request failed (" + vres.status + ")");
      const j = await vres.json();
      (j.voices || []).forEach((v) => {
        const l = v.labels || {};
        const extra = [l.accent, l.gender].filter(Boolean).join(", ");
        voices.push({ id: v.voice_id, label: v.name + (extra ? " · " + extra : ""), group: v.category });
      });
      if (!j.has_more || !j.next_page_token) break;
      token = j.next_page_token;
    }
    const pref = ["eleven_multilingual_v2", "eleven_flash_v2_5"].find((id) => models.some((m) => m.id === id));
    const data = {
      models,
      defaultModel: pref || (models[0] && models[0].id) || "eleven_multilingual_v2",
      voices,
      defaultVoice: voices[0] ? voices[0].id : "",
      controls: ["stability"],
      note: "Models and voices are loaded from your ElevenLabs account.",
    };
    elCache = { at: Date.now(), data };
    return data;
  },
  build(key, { text, model, voice, options }) {
    if (!idOk(voice)) throw Object.assign(new Error("Choose an ElevenLabs voice first."), { status: 400 });
    const body = { text, model_id: idOk(model) ? model : "eleven_multilingual_v2" };
    const s = num(options.stability, 0, 1);
    if (s !== undefined) body.voice_settings = { stability: s };
    return {
      url: env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io") + "/v1/text-to-speech/" + encodeURIComponent(voice) + "?output_format=mp3_44100_128",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },
  okModel: idOk,
};

/* ---------------- Deepgram ---------------- */
const DG = {
  "English": ["amalthea","andromeda","apollo","arcas","aries","asteria","athena","atlas","aurora","callista","cora","cordelia","delia","draco","electra","harmonia","helena","hera","hermes","hyperion","iris","janus","juno","jupiter","luna","mars","minerva","neptune","odysseus","ophelia","orion","orpheus","pandora","phoebe","pluto","saturn","selene","thalia","theia","vesta","zeus"],
  "Spanish": ["sirio","nestor","carina","celeste","alvaro","diana","aquila","selena","estrella","javier","agustina","antonia","gloria","luciano","olivia","silvia","valerio"],
  "Dutch": ["beatrix","daphne","cornelia","sander","hestia","lars","roman","rhea","leda"],
  "French": ["agathe","hector"],
  "German": ["elara","aurelia","lara","julius","fabian","kara","viktoria"],
  "Italian": ["melia","elio","flavio","maia","cinzia","cesare","livia","dionisio","demetra"],
  "Japanese": ["uzume","ebisu","fujin","izanami","ama"],
};
const DG_SUFFIX = { English: "en", Spanish: "es", Dutch: "nl", French: "fr", German: "de", Italian: "it", Japanese: "ja" };
const deepgram = {
  label: "Deepgram",
  keyVar: "DEEPGRAM_API_KEY",
  maxChars: 2000,
  catalog: async () => ({
    models: [{ id: "aura-2", label: "Aura 2" }],
    defaultModel: "aura-2",
    voices: Object.entries(DG).flatMap(([lang, names]) =>
      names.map((n) => ({ id: `aura-2-${n}-${DG_SUFFIX[lang]}`, label: `${cap(n)} · ${lang}`, group: lang }))),
    defaultVoice: "aura-2-thalia-en",
    controls: [],
    note: "The voice sets the language.",
  }),
  build(key, { text, voice }) {
    const v = /^aura(-2)?-[a-z]+-[a-z]{2}$/.test(voice || "") ? voice : "aura-2-thalia-en";
    return {
      url: env("DEEPGRAM_BASE_URL", "https://api.deepgram.com") + "/v1/speak?model=" + encodeURIComponent(v),
      headers: { Authorization: "Token " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    };
  },
  okModel: () => true,
};

const PROVIDERS = { sarvam, openai, elevenlabs, deepgram };
const keyFor = (id) => process.env[PROVIDERS[id].keyVar] || "";

module.exports = { PROVIDERS, keyFor };
