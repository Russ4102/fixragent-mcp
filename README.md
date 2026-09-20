# fixragent-mcp

One MCP tool, `triage_photo`, in front of `https://fixragent.com/api/triage`.

fixRAgent triages a maintenance photo in ten seconds: what it is, how urgent, who to call, what to say right now. This server lets an agent — Claude Desktop, Claude Code, Cursor, or any client that speaks the Model Context Protocol — send a photo and get the same fixed JSON the API returns, plus a link to the Triage Profile.

- One file, `server.js`. No runtime dependencies. Node 20 or newer.
- Speaks MCP over stdio in both eras: the `initialize` handshake every shipping client uses today (2025-11-25 back to 2024-11-05) and the per-request `_meta` form of the 2026-07-28 revision (`server/discover`, `resultType`).
- The key is read from the `FIXRAGENT_API_KEY` environment variable and sent as the `x-triage-key` header. It is never written to a file, stdout or stderr.
- `FIXRAGENT_API_URL` (optional) points the tool at another base, such as the mock below; the default is `https://fixragent.com`.
- Every call carries `variant: source:mcp`, so its traffic is counted as channel `mcp`, on its own line beside the web profile and direct API calls (channel `api`).

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
| `image_path` | string | a file on the machine the server runs on; JPEG, PNG or WebP; at most 3 MB |
| `image_base64` | string | the photo as base64 instead of a path; a `data:image/...;base64,` prefix is accepted |
| `mime_type` | `image/jpeg` · `image/png` · `image/webp` | required |
| `problem_text` | string, at most 1,200 characters | the problem in the reporter's own words; treated as reported symptoms, never as ground truth |
| `role` | `landlord` (default) · `fixer` | who is asking; changes the wording of the profile, not the triage |
| `config` | `fast` (default) · `deep` | `fast` reads the photo three times on production and `deep` five; both report how many reads agreed, and `agreement.n` is the count that ran — `deep` takes longer and spends more of the day's demo budget |

Give `image_path` or `image_base64`, never both.

The result is the API's reply, unchanged, plus two links built from `diagnosis_id`:

| field | what it is |
|---|---|
| `diagnosis_id` | the server-minted id; the join key for the outcome |
| `core` | the 20 fixed fields: `asset_type`, `fault_detected`, `fault_summary`, `severity`, `tier` (one of `EMERGENCY`, `TODAY`, `THIS WEEK`, `WHENEVER`), `trade_required`, `resident_explanation`, `safety_hazard`, `hazard_detail`, the two photo-borne facts `visible_wiring` and `water_near_electrical`, and the rest — see [/docs#core](https://fixragent.com/docs#core) |
| `agreement` | how many reads gave the same yes/no answer about a fault: `n` reads ran, `k` agreed, `decided` when the agreeing reads are at least half |
| `engine_version` · `rubric_version` · `config_id` | which engine, which rubric, which config produced this; a `config_id` beginning `fallback-` means a hardcoded config answered, not a measured candidate |
| `callback_url` | the `/api/outcome` path for this `diagnosis_id` |
| `share_url` | the profile as a page: `https://fixragent.com/c/<diagnosis_id>` |
| `outcome_url` | two taps to tell us what happened: `https://fixragent.com/o/<diagnosis_id>` |
| `warnings` | anything you should not miss, such as a config fallback |

The tool returns the JSON both as `structuredContent` and as text, and declares an `outputSchema` a client can validate against.

## A worked example

A person says, in Claude Desktop: *"Triage the photo at ~/Downloads/toilet-tank.jpg."* The client calls:

```json
{ "name": "triage_photo",
  "arguments": { "image_path": "/Users/me/Downloads/toilet-tank.jpg", "mime_type": "image/jpeg" } }
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

The agent can then say what the profile would say: WHENEVER — healthy, cosmetic, or not a building asset; no dispatch is owed; all three reads agreed — and hand over `share_url`.

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
| photo over 3 MB (413, or refused locally before sending) | "That photo is larger than 3 MB…" |
| format that cannot be cleaned of metadata (415) | "That image format is refused (415)… Send a JPEG, PNG or WebP." |
| the day's budget is spent (503) | "The demo has used its compute budget for today (503). This is a limit on our side, not a problem with your photo…" |
| the mock refused a body over 1 MB (400) | "b1442b0b-….mock.pstmn.io could not use that request (400 badRequest). The API said: …exceeds the 1mb size limit." |
| the engine gave no usable answer (502) | "fixragent.com could not produce a triage for this photo (502…). Try once more…" |

## How it fits

- It routes: what the photo shows, one of four urgency words, which trade. Gas, water near electrics and exposed wiring go straight to a licensed trade, and the profile says so.
- One fixed JSON shape every time, which your developers map to your own work-order fields.
- Use it today with a demo key.
- Agreement counts how often the reads matched each other; the outcome loop at `outcome_url` checks each triage against what actually happened.
- The one-file install above is the install: download `server.js`, set the key, register it.

## What happens to your photo

Every uploaded photo has its metadata stripped — EXIF, XMP, IPTC and the other carriers that hold GPS — before it is hashed, before it is sent to the engine, and before anything is stored. If the metadata cannot be stripped, the photo is refused (415 or 500) rather than processed. The endpoint stores no photo bytes; it keeps the SHA-256 of the stripped version, and the triage row it writes carries `role` and `variant` (`source:mcp`). The engine provider keeps prompt, response and photo for 55 days. Full text: [fixragent.com/docs#photos](https://fixragent.com/docs#photos) and [fixragent.com/privacy](https://fixragent.com/privacy).

## Privacy Policy

The published policy is at **https://fixragent.com/privacy**. This section states what *this server* does, so it
can be read without leaving the repository.

**What is collected.** A call to `triage_photo` sends to `https://fixragent.com/api/triage`: the photograph, its
MIME type, the `problem_text` you passed (if any), the `role` and `config` you chose, and the fixed string
`source:mcp`. The key travels as the `x-triage-key` header. **This server keeps no copy, writes no log, and reads
no file other than the one named in `image_path`** — and when `image_path` is used, only the bytes are sent, never
the path or the file name.

**How it is used and stored.** Metadata — EXIF, XMP, IPTC and the other carriers that hold GPS — is stripped
before the photo is hashed, before it reaches the engine, and before anything is stored; a photo that cannot be
stripped is refused rather than processed. **The endpoint stores no photo bytes.** It keeps the SHA-256 of the
stripped image and a triage row carrying `role` and `variant`, so that the profile's page and the outcome
callback can be served.

**Third parties, and what each holds.** The photograph is read by the model provider's API
(`generativelanguage.googleapis.com`). **The engine provider keeps prompt, response and photo for 55 days.**
Hosting is Vercel; the database is Supabase. Nothing is sold, and nothing is shared for advertising.

**Retention and your control.** `share_url` (`https://fixragent.com/c/<diagnosis_id>`) is a page anyone holding
the link can open — treat the link as you would the photograph. To have a diagnosis removed, send its
`diagnosis_id` to support@fixragent.com. The rest of the retention terms are in the published policy.

**Your key.** Read from `FIXRAGENT_API_KEY` at call time; never written to a file, to stdout or to stderr, and
never quoted in an error — a key that cannot go into a header produces a fixed `KEY_UNSENDABLE` sentence instead
of Node's own message, which would otherwise contain it.

**Contact.** support@fixragent.com · legal@fixragent.com · https://fixragent.com/help
AR Logic LLC, Ohio, United States.

## Test it

```sh
npm install            # dev dependency only: the official SDK, used as the reference client
npm test               # a local stub replays captured API replies; no key, no spend, no rows
npm run test:live -- --photo ./photo.jpg   # adds a wrong-key 401 on production and one real triage
```

The harness has two canaries (`MCP_TEST_CANARY=401-as-200`, `MCP_TEST_CANARY=drop-core`) that make a case go red on purpose, so each check has been seen to fail.

## The rest of the surface

- [fixragent.com/docs](https://fixragent.com/docs) — the reference, field by field
- [fixragent.com/openapi.json](https://fixragent.com/openapi.json) · [openapi.yaml](https://fixragent.com/openapi.yaml)
- [Postman collection](https://fixragent.com/docs/fixragent-triage-api.postman_collection.json)
- [Agents quickstart](https://fixragent.com/docs/AGENTS-QUICKSTART.txt)
- [llms.txt](https://fixragent.com/llms.txt)

MIT licence. Made by AR Logic LLC.
