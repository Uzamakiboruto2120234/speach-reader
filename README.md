# Read Aloud

A text-to-speech content reader. Paste text, open a `.txt` / `.md` file or load
a web page, then listen with the current sentence highlighted.

Voices come from five places. Pick one in the Voice panel:

| Provider | Needs | Notes |
|---|---|---|
| Browser (free) | nothing | Voices built into your OS. Offline. Highlights each word. |
| Sarvam | `SARVAM_API_KEY` | Indian languages and English. Models bulbul v3, v4 Flash, v2. |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini-tts` (takes style instructions), `tts-1-hd`, `tts-1`. |
| ElevenLabs | `ELEVENLABS_API_KEY` | Models and voices are loaded from your account. |
| Deepgram | `DEEPGRAM_API_KEY` | Aura 2 voices in English, Spanish, Dutch, French, German, Italian, Japanese. |

## Run it

1. Install Node 18 or newer.
2. Copy `.env.example` to `.env` and add the key for each provider you want.
3. Run `node server.js`, then open http://localhost:3000

Keys stay in the server on your machine. The page never sees them, and the
server only listens on `127.0.0.1`. A provider with no key still appears in
the list and tells you which variable to set.

## What it does

- **Click a sentence** to start there. **Space** plays or pauses, **← →** skip
  a passage, **[ ]** change speed.
- **Speed** works for every provider and changes instantly, with no new
  request and no extra cost (it is applied in the player).
- **Sleep timer**: 15 to 60 minutes with a short fade-out on provider voices, or stop at the end
  of the current paragraph.
- **Remembers your place.** Reopen the page and press play to continue.
- **From web page** fetches an article and strips menus, ads and footers. It
  only accepts public http(s) addresses, so it cannot be pointed at services on
  your own machine or network.
- **Skip markdown symbols and links** (on by default) removes `#`, `**`,
  backticks, URLs and code blocks so they are not read out.
- **Save as MP3** generates every passage and downloads one file. It is not
  available for browser voices.
- **Preview** plays the current passage once with the voice you picked.
- Light, dark or system theme.

## How it works

Text is split into sentences. Short neighbours are grouped into passages of up
to about 400 characters, one request each, which keeps every request far under
each provider's limit. The next two passages are fetched while one plays, and
replaying a passage with the same settings reuses the audio from this session.
With provider voices the highlight moves between sentences by playback time.
Only browser voices report which word is being spoken.

## Costs and limits

- Every passage played or saved is a billed request to that provider. The
  character count under the text box shows how much a full read-through sends.
- Provider voice lists and model names change. ElevenLabs is read live from
  your account. The Sarvam, OpenAI and Deepgram lists are built in; if a name
  is rejected, the provider's message appears next to the play button, and you
  can type any ID into **Or a voice ID**.
- Sarvam's v4 Flash catalog uses longer IDs such as `ishita_hi_devotional`.
  Leave the voice on Default, or paste a full ID from Sarvam's voices page.

## Files

- `server.js`: routes and streaming pass-through
- `providers.js`: one adapter per provider (request shape, models, voices)
- `extract.js`: web page to readable text, with the address guard
- `public/`: the page (`index.html`, `style.css`, `app.js`)
# speach-reader
