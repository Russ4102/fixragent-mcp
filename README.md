# fixragent-mcp

One MCP tool, `triage_photo`, in front of `https://fixragent.com/api/triage`.

fixRAgent triages a maintenance photo in ten seconds: what it is, how urgent, who to call, what to say right now. This server lets an agent — Claude Desktop, Claude Code, Cursor, or any client that speaks the Model Context Protocol — send a photo and get the same fixed JSON the API returns, plus a link to the card.

- One file, `server.js`. No runtime dependencies. Node 20 or newer.
- Speaks MCP over stdio in both eras: the `initialize` handshake every shipping client uses today (2025-11-25 back to 2024-11-05) and the per-request `_meta` form of the 2026-07-28 revision (`server/discover`, `resultType`).
- The key is read from the `FIXRAGENT_API_KEY` environment variable and sent as the `x-triage-key` header. It is never written to a file, stdout or stderr.
- `FIXRAGENT_API_URL` (optional) points the tool at another base, such as the mock below; the default is `https://fixragent.com`.
- `FIXRAGENT_IMAGE_DIR` (optional) is the one folder `image_path` may read photos from. **Unset, `image_path` is off** and only `image_base64` works. See [Reading photo files](#reading-photo-files).
- Every call carries `variant: source:mcp`, so its traffic is counted as channel `mcp`, on its own line beside the web card and direct API calls (channel `api`).

## Install

The install is one file: `server.js`.

```sh
mkdir -p ~/fixragent-mcp
curl -fsSL https://fixragent.com/mcp/server.js -o ~/fixragent-mcp/server.js
node ~/fixragent-mcp/server.js --check
```

`--check` prints whether the key is set and whether fixragent.com answers. It never prints the key.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop.

```json
{
  "mcpServers": {
    "fixragent": {
      "command": "node",
      "args": ["/absolute/path/to/fixragent-mcp/server.js"],
      "env": { "FIXRAGENT_API_KEY": "your demo key" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add fixragent -e FIXRAGENT_API_KEY=your-demo-key -- node /absolute/path/to/fixragent-mcp/server.js
```

### Cursor

Create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "fixragent": {
      "command": "node",
      "args": ["/absolute/path/to/fixragent-mcp/server.js"],
      "env": { "FIXRAGENT_API_KEY": "your demo key" }
    }
  }
}
```

## The key

Ask at [fixragent.com/docs#key](https://fixragent.com/docs#key), or email legal@fixragent.com with one line on what you are building, and a person replies with your key.

Without a key the tool answers, in words, that no key is set and that nothing was sent.

To wire up a client before a key arrives, point the tool at the mock, which replays captured replies ([details](https://fixragent.com/docs#mock)). The mock reads no key, and the tool sends only when one is set, so give it a placeholder. In the client config above, the `env` block becomes:

```json
"env": { "FIXRAGENT_API_URL": "https://b1442b0b-4a7a-4135-ab4d-9c4b9c1ab0d2.mock.pstmn.io", "FIXRAGENT_API_KEY": "placeholder" }
```

The mock takes a request body of up to 1 MB, which holds a photo of about 700 KB, so give the tool a small copy of your photo: `sips -Z 1024 photo.jpg --out photo-small.jpg` on macOS, or on Linux with Pillow:

```sh
python3 -c "from PIL import Image, ImageOps; im = ImageOps.exif_transpose(Image.open('photo.jpg')); im.thumbnail((1024, 1024)); im.convert('RGB').save('photo-small.jpg', quality=85)"
```

The reply is a captured triage, and its `share_url` points at that captured `diagnosis_id`. When your key arrives, remove `FIXRAGENT_API_URL` and put the key in `FIXRAGENT_API_KEY`.

## The tool

`triage_photo`

| input | type | notes |
|---|---|---|
| `image_path` | string | a file inside the `FIXRAGENT_IMAGE_DIR` folder (off when that is not set); a relative path is taken inside that folder; JPEG, PNG or WebP; 1 KB to 3 MB |
| `image_base64` | string | the photo as base64 instead of a path; a `data:image/...;base64,` prefix is accepted, and line breaks are ignored; 1 KB to 3 MB decoded |
| `mime_type` | `image/jpeg` · `image/png` · `image/webp` | required |
| `problem_text` | string, at most 1,200 characters | the problem in the reporter's own words; treated as reported symptoms, never as ground truth |
| `role` | `landlord` (default) · `fixer` | who is asking; changes the wording of the card, not the triage |
| `config` | `fast` (default) · `deep` | `fast` reads the photo three times on production and `deep` five; both report how many reads agreed, and `agreement.n` is the count that ran — `deep` takes longer and spends more of the day's demo budget |

Give `image_path` or `image_base64`, never both.

### Reading photo files

The tool's arguments are written by the model, and a model can be steered by text it has read (a web page, an email, a file: a prompt injection). If `image_path` could name any file, a steered model could name a private key or a `.env` file and the server would send its bytes to the API. So `image_path` is **off by default**. To turn it on, name one folder:

```json
"env": { "FIXRAGENT_API_KEY": "your demo key", "FIXRAGENT_IMAGE_DIR": "/Users/me/fixragent-photos" }
```

```sh
claude mcp add fixragent -e FIXRAGENT_API_KEY=your-demo-key -e FIXRAGENT_IMAGE_DIR=/Users/me/fixragent-photos -- node /absolute/path/to/fixragent-mcp/server.js
```

With the folder set, before anything is sent:

- the file's real path (symlinks followed) must be inside that folder; a path outside it gets the same sentence whether or not a file is there;
- it must be a regular file of 1 KB to 3 MB;
- its first bytes must be a JPEG, PNG, WebP, GIF or HEIC image.

`image_base64` goes through the same checks on the decoded bytes (1 KB to 3 MB, image first bytes), and the string must be base64 and nothing else (A–Z, a–z, 0–9, `+`, `/`, `=` padding; line breaks are ignored). Point `FIXRAGENT_IMAGE_DIR` at a folder that holds only photos, never at your home folder.

The result is the API's reply, unchanged, plus two links built from `diagnosis_id`:

| field | what it is |
|---|---|
| `diagnosis_id` | the server-minted id; the join key for the outcome |
| `core` | the 20 fixed fields: `asset_type`, `fault_detected`, `fault_summary`, `severity`, `tier` (one of `EMERGENCY`, `TODAY`, `THIS WEEK`, `WHENEVER`), `trade_required`, `resident_explanation`, `safety_hazard`, `hazard_detail`, the two photo-borne facts `visible_wiring` and `water_near_electrical`, and the rest — see [/docs#core](https://fixragent.com/docs#core) |
| `agreement` | how many reads gave the same yes/no answer about a fault: `n` reads ran, `k` agreed, `decided` when the agreeing reads are at least half |
| `engine_version` · `rubric_version` · `config_id` | which engine, which rubric, which config produced this; a `config_id` beginning `fallback-` means a hardcoded config answered, not a measured candidate |
| `callback_url` | the `/api/outcome` path for this `diagnosis_id` |
| `share_url` | the card as a page: `https://fixragent.com/c/<diagnosis_id>` |
| `outcome_url` | two taps to tell us what happened: `https://fixragent.com/o/<diagnosis_id>` |
| `warnings` | anything you should not miss, such as a config fallback |

The tool returns the JSON both as `structuredContent` and as text, and declares an `outputSchema` a client can validate against.

## A worked example

The server runs with `FIXRAGENT_IMAGE_DIR=/Users/me/fixragent-photos`. A person says, in Claude Desktop: *"Triage the photo toilet-tank.jpg."* The client calls:

```json
{ "name": "triage_photo",
  "arguments": { "image_path": "/Users/me/fixragent-photos/toilet-tank.jpg", "mime_type": "image/jpeg" } }
```

An abridged reply, from a production response captured 14 Sep 2026 (three reads, all three agreed). That reply came through the curl door; the tool returns the same JSON and adds `share_url` and `outcome_url`:

```json
{
  "diagnosis_id": "ae0deb3c-98c2-42ee-bad7-d4c0e62dd0a7",
  "engine_version": "engine-v2-vote-1.0.0",
  "rubric_version": "v1.1-2026-09-11",
  "config_id": "fast-…",
  "agreement": {
    "mode": "fast",
    "n": 3,
    "k": 3,
    "decided": true
  },
  "core": {
    "is_building_asset": true,
    "asset_type": "Toilet",
    "asset_category": "PLUMBING",
    "photo_subject": "Interior of an Eljer toilet tank showing fill valve, flapper, and flush handle arm.",
    "fault_detected": false,
    "fault_summary": "",
    "severity": "P4",
    "tier": "WHENEVER",
    "trade_required": null,
    "safety_hazard": false,
    "hazard_detail": null,
    "resident_explanation": "The toilet tank components appear to be in good working condition with no visible faults."
  },
  "callback_url": "/api/outcome?diagnosis_id=ae0deb3c-98c2-42ee-bad7-d4c0e62dd0a7",
  "warnings": [],
  "share_url": "https://fixragent.com/c/ae0deb3c-98c2-42ee-bad7-d4c0e62dd0a7",
  "outcome_url": "https://fixragent.com/o/ae0deb3c-98c2-42ee-bad7-d4c0e62dd0a7"
}
```

The agent can then say what the card would say: WHENEVER — healthy, cosmetic, or not a building asset; no dispatch is owed; all three reads agreed — and hand over `share_url`.

## Limits

These are the API's guards, in the order they are checked. When one stops you, the tool says which, in a sentence, with the seconds to wait taken from the `Retry-After` header.

- 20 requests an hour from one address.
- 60 requests a day on the shared demo key.
- A ceiling of twenty dollars a day on what the demo can spend on our side, counted per warm server. Past it the API answers 503 and spends nothing; the budget resets at 00:00 UTC.
- Photos: at least 1 KB and at most 3 MB decoded. The photo travels base64 inside a JSON body and the platform caps the body at 4.5 MB, so 3 MB of photo is the ceiling.
- A fast triage runs three reads and returns in about 25 seconds (measured 13–14 Sep 2026 on production, `config=fast`; each read took 5.4 to 5.7 seconds).
- A deep read is five reads; give it up to 90 seconds.

## What the tool says when it fails

Each failure has its own sentence.

| what happened | what the tool says |
|---|---|
| no key in `FIXRAGENT_API_KEY` | "No key is set here, so nothing was sent…" — nothing was sent |
| the key holds a line break, a tab or a non-ASCII character | "The key in FIXRAGENT_API_KEY holds a character a request header cannot carry…" — nothing was sent |
| the API refused the key (401) | "fixragent.com refused the key (401 demo_key_required). Check the value in FIXRAGENT_API_KEY…" and the API's own sentence |
| too many from this address (429) | "Too many requests from this address (429)… Try again in N seconds" |
| the key's day is used up (429) | "This demo key has used its 60 requests for today (429). The count resets at 00:00 UTC. Try again in N seconds" |
| `image_path` given but `FIXRAGENT_IMAGE_DIR` is not set | "image_path is switched off on this server, so no file was read and nothing was sent…" |
| `image_path` outside the folder, or a symlink leading out of it | "image_path must name a file inside the folder in FIXRAGENT_IMAGE_DIR…" — nothing was read or sent |
| the bytes are not an image (by their first bytes) | "That is not a photo: its first bytes are not a JPEG, PNG, WebP, GIF or HEIC image. Nothing was sent." |
| `image_base64` is not base64 | "image_base64 is not base64 (only A-Z, a-z, 0-9, +, / and = padding, in groups of four). Nothing was sent." |
| photo under 1 KB (refused locally) | "That photo is under 1 KB (N bytes)… Nothing was sent." |
| photo over 3 MB (413, or refused locally before sending) | "That photo is larger than 3 MB…" |
| format that cannot be cleaned of metadata (415) | "That image format is refused (415)… Send a JPEG, PNG or WebP." |
| the day's budget is spent (503) | "The demo has used its compute budget for today (503). This is a limit on our side, not a problem with your photo…" |
| the mock refused a body over 1 MB (400) | "b1442b0b-….mock.pstmn.io could not use that request (400 badRequest). The API said: …exceeds the 1mb size limit." |
| the engine gave no usable answer (502) | "fixragent.com could not produce a triage for this photo (502…). Try once more…" |

## How it fits

- It routes: what the photo shows, one of four urgency words, which trade. Gas, water near electrics and exposed wiring go straight to a licensed trade, and the card says so.
- One fixed JSON shape every time, which your developers map to your own work-order fields.
- Use it today with a demo key.
- Agreement counts how often the reads matched each other; the outcome loop at `outcome_url` checks each triage against what actually happened.
- The one-file install above is the install: download `server.js`, set the key, register it.

## What happens to your photo

Every uploaded photo has its metadata stripped — EXIF, XMP, IPTC and the other carriers that hold GPS — before it is hashed, before it is sent to the engine, and before anything is stored. If the metadata cannot be stripped, the photo is refused (415 or 500) rather than processed. The endpoint stores no photo bytes; it keeps the SHA-256 of the stripped version, and the triage row it writes carries `role` and `variant` (`source:mcp`). The engine provider keeps prompt, response and photo for 55 days. Full text: [fixragent.com/docs#photos](https://fixragent.com/docs#photos) and [fixragent.com/privacy](https://fixragent.com/privacy).

## Privacy Policy

This server sends the photo and the text you give it to `https://fixragent.com/api/triage` and nothing else; it keeps no copy, writes no log, and reads no file at all unless `FIXRAGENT_IMAGE_DIR` is set, and then only the image file named in `image_path` inside that folder. What fixragent.com does with what it receives is in the privacy policy at [https://fixragent.com/privacy](https://fixragent.com/privacy). Contact: legal@fixragent.com.

## Test it

```sh
npm install            # dev dependency only: the official SDK, used as the reference client
npm test               # a local stub replays captured API replies; no key, no spend, no rows
npm run test:live -- --photo ./photo.jpg   # adds a wrong-key 401 on production and one real triage
```

The harness has three canaries (`MCP_TEST_CANARY=401-as-200`, `MCP_TEST_CANARY=drop-core`, `MCP_TEST_CANARY=drift`) that make a case go red on purpose, so each check has been seen to fail.

The contract case compares the tool's `core` fields with `components.schemas.TriageCore` in the published spec, `https://fixragent.com/openapi.json` (one GET, no photo, no key). `MCP_TEST_OPENAPI=<file or URL>` points it at another copy. If the spec cannot be read the case FAILS; `MCP_TEST_OFFLINE=1` turns that into an explicit SKIP.

`MCP_TEST_SERVER=<path to another server.js>` runs the same cases against another copy, such as a copy with one guard removed, to show that guard's cases go red.

## The rest of the surface

- [fixragent.com/docs](https://fixragent.com/docs) — the reference, field by field
- [fixragent.com/openapi.json](https://fixragent.com/openapi.json) · [openapi.yaml](https://fixragent.com/openapi.yaml)
- [Postman collection](https://fixragent.com/docs/fixragent-triage-api.postman_collection.json)
- [Agents quickstart](https://fixragent.com/docs/AGENTS-QUICKSTART.txt)
- [llms.txt](https://fixragent.com/llms.txt)

MIT licence. Made by ARLogic LLC.
