#!/usr/bin/env node
'use strict';
/**
 * fixragent-mcp — one MCP tool, `triage_photo`, in front of https://fixragent.com/api/triage.
 *
 * Zero runtime dependencies. Node 20 or newer. Speaks the Model Context Protocol over stdio:
 *   - the legacy era every shipping client uses today (an `initialize` handshake; revisions
 *     2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 — the set the official SDK 1.30.0 supports), and
 *   - the modern era (revision 2026-07-28: per-request `_meta`, `server/discover`, `resultType`),
 *   so a client of either kind gets the same tool. Spec read 13 Sep 2026:
 *   https://modelcontextprotocol.io/specification/2026-07-28 and /specification/2025-11-25/basic/lifecycle.
 *
 * The key never lives in this file. It is read from the FIXRAGENT_API_KEY environment variable at
 * call time, sent as the x-triage-key header, and never written to stdout or stderr.
 *
 * What this tool does: it routes the job. It returns the API's triage — what the photo shows, one of four urgency
 * words, which trade — and a link to the card. Gas, water near electrics and exposed wiring go straight to a licensed trade.
 *
 * FIXRAGENT_API_URL (optional) points the tool at another base, such as the Postman mock; the default is https://fixragent.com.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SERVER = { name: 'fixragent-mcp', title: 'fixRAgent triage', version: '0.1.0', websiteUrl: 'https://fixragent.com/docs' };
const MODERN_VERSIONS = ['2026-07-28'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const KEY_ENV = 'FIXRAGENT_API_KEY';
const API_BASE = (process.env.FIXRAGENT_API_URL || 'https://fixragent.com').replace(/\/+$/, '');
const API_HOST = (function () { try { return new URL(API_BASE).host; } catch (_) { return API_BASE; } })(); // named in every failure sentence
const SITE = 'https://fixragent.com';
const MAX_PHOTO_BYTES = 3145728; // the API's ceiling: 3 MB decoded (openapi.json, x-fixr.photo_limits)
const MAX_PROBLEM_TEXT = 1200;
const CALL_TIMEOUT_MS = 90000;   // a deep triage is five reads on production (fast is three); the API's own ceiling is 60 s
const USER_AGENT = 'fixragent-mcp/' + SERVER.version;

// The key is cleaned the way api/triage.js cleanKey cleans it on the server (invisible characters from a copy-paste,
// surrounding quotes, whitespace), so a key that matches there is sent the same way here. What is left must be
// printable ASCII before it goes into a header: Node puts an invalid header VALUE into its error message, so a key
// with a line break inside would otherwise come back in the tool result. A header problem gets KEY_UNSENDABLE, a
// fixed sentence, and never the error's own text.
function cleanKey(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200b-\u200d\u2060\ufeff\u202f\xa0]/g, '')
    .trim()
    .replace(/^["'\u201c\u201d\u2018\u2019]+/, '')
    .replace(/["'\u201c\u201d\u2018\u2019]+$/, '')
    .trim();
}
const HEADER_SAFE = /^[\x20-\x7e]+$/;
const KEY_UNSENDABLE = 'The key in ' + KEY_ENV + ' holds a character a request header cannot carry (a line break, a tab or a ' +
  'non-ASCII character), so nothing was sent. Set the key again as one line of plain characters and restart this server.';
function networkCode(e) {
  const c = (e && e.cause && e.cause.code) || (e && e.code) || '';
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c) ? c : 'the request did not complete';
}

const INSTRUCTIONS =
  'One tool, triage_photo. Give it a photo of something in a building (an appliance, a fitting, a pipe, a panel) ' +
  'and, if you have them, the problem in the reporter\'s own words. You get back what it is, whether a fault is ' +
  'visible, one of four urgency words (EMERGENCY, TODAY, THIS WEEK, WHENEVER), which trade to call, a line to say ' +
  'to the tenant, and a share_url for the card. Each call spends one of the demo key\'s 60 requests a day. ' +
  'The key comes from the FIXRAGENT_API_KEY environment variable; request one at https://fixragent.com/docs#key. ' +
  'The reply routes the job: what the photo shows, one of four urgency words, which trade. Gas, water near electrics and exposed wiring go straight to a licensed trade.';

// ── the tool ────────────────────────────────────────────────────────────────
// core fields and enums mirror openapi.json components.schemas.TriageCore (20 fields). mcp/test/run.mjs
// fails when the two drift (reflex rule 11 — a fact recorded in two places drifts).
const CORE_PROPERTIES = {
  is_building_asset: { type: 'boolean', description: 'False when the photo is a person, pet, vehicle, food or document.' },
  asset_type: { type: ['string', 'null'], description: 'The specific asset, named ("Gas water heater"). Null only when is_building_asset is false.' },
  asset_category: { type: 'string', description: 'HVAC | PLUMBING | ELECTRICAL | APPLIANCE | STRUCTURAL | OTHER | NOT_AN_ASSET.' },
  photo_subject: { type: 'string', description: 'What is actually in frame, from the pixels alone.' },
  report_photo_agreement: { type: ['string', 'null'], enum: ['true', 'false', 'uncertain', null], description: 'Does the reported problem describe what the photo shows. Null when no problem_text was sent.' },
  fault_detected: { type: 'boolean', description: 'The verdict. Rides the photo, not the report.' },
  fault_visible_in_photo: { type: ['boolean', 'null'], description: 'Whether the named fault is visible. Null when the engine did not answer.' },
  fault_summary: { type: 'string', description: 'One paragraph for the person dispatching. Empty when no fault.' },
  fault_classes: { type: 'array', items: { type: 'string' }, description: 'Taxonomy class ids, primary first. Empty when fault_detected is false.' },
  severity: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'], description: 'Assigned by the server from the rubric, never taken from the model.' },
  tier: { type: 'string', enum: ['EMERGENCY', 'TODAY', 'THIS WEEK', 'WHENEVER'], description: 'The only urgency wording a card may use. A pure function of severity.' },
  criterion_1_fired: { type: 'boolean', description: 'True when visible wiring or water near anything electrical forced EMERGENCY.' },
  tier_forced_by: { type: ['string', 'null'], description: 'Which rule overrode the decision table, when one did.' },
  visible_wiring: { type: 'boolean', description: 'Photo-borne fact: a conductor, splice or terminal a person could touch. Uncertain reads as false, on purpose.' },
  water_near_electrical: { type: 'boolean', description: 'Photo-borne fact: water in contact with, above, or beneath an electrical device. Uncertain reads as false, on purpose.' },
  safety_hazard: { type: 'boolean', description: 'A hazard exists. Every top-severity reply carries one; not every hazard is top severity.' },
  hazard_detail: { type: ['string', 'null'], description: 'The named hazard. Non-empty when, and only when, safety_hazard is true.' },
  trade_required: { type: ['string', 'null'], description: 'The trade to dispatch. Null when there is no fault.' },
  confidence: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'The engine\'s own stated probability that fault_detected is right. Uninformative on its own; read agreement instead.' },
  resident_explanation: { type: 'string', description: 'Plain language, for the resident. Filled on every reply.' }
};

const TOOL = {
  name: 'triage_photo',
  title: 'Triage a maintenance photo',
  description:
    'Send one photo of something in a building to fixragent.com and get the fixed JSON triage back: what it is, ' +
    'whether a fault is visible, one of four urgency words (EMERGENCY, TODAY, THIS WEEK, WHENEVER), which trade to ' +
    'call, a line to say to the tenant, and how many reads agreed. Spends one request on the demo key (60 a day). ' +
    'Returns a diagnosis_id, a share_url for the card, and a callback_url for reporting what actually happened. ' +
    'Give either image_path or image_base64, never both. image_path works only when the server was started with ' +
    'FIXRAGENT_IMAGE_DIR, and only for files inside that folder. JPEG, PNG or WebP, 1 KB to 3 MB; bytes that are not an image are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: { type: 'string', description: 'Path to the photo inside the folder named by FIXRAGENT_IMAGE_DIR (off when that is not set). JPEG, PNG or WebP, 1 KB to 3 MB.' },
      image_base64: { type: 'string', description: 'The photo as base64. A data:image/...;base64, prefix is accepted.' },
      mime_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'], description: 'The photo\'s type.' },
      problem_text: { type: 'string', maxLength: MAX_PROBLEM_TEXT, description: 'The problem in the reporter\'s own words, if any. Treated as reported symptoms, never as ground truth.' },
      role: { type: 'string', enum: ['landlord', 'fixer'], default: 'landlord', description: 'Who is asking: the landlord, or the one fixing it. Changes the wording of the card, not the triage.' },
      config: { type: 'string', enum: ['fast', 'deep'], default: 'fast', description: 'fast reads the photo three times on production and deep five; both report how many reads agreed, and agreement.n in the reply is the count that ran. deep takes longer and spends more of the day\'s demo budget.' }
    },
    required: ['mime_type'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      diagnosis_id: { type: 'string', description: 'Server-minted id. The path segment in share_url and outcome_url, and the join key for the outcome.' },
      engine_version: { type: 'string' },
      rubric_version: { type: 'string' },
      config_id: { type: 'string', description: 'An id beginning "fallback-" means a hardcoded config answered, not a measured candidate.' },
      callback_url: { type: 'string', description: 'The /api/outcome path for this diagnosis_id. POST { diagnosis_id, outcome } there when you know what happened.' },
      share_url: { type: 'string', description: 'The card, as a page: https://fixragent.com/c/<diagnosis_id>' },
      outcome_url: { type: 'string', description: 'Two taps to tell us what happened: https://fixragent.com/o/<diagnosis_id>' },
      core: { type: 'object', properties: CORE_PROPERTIES, required: Object.keys(CORE_PROPERTIES) },
      agreement: { type: ['object', 'null'], description: 'How many reads agreed: n reads ran, k agreed.' },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['diagnosis_id', 'engine_version', 'rubric_version', 'config_id', 'callback_url', 'share_url', 'outcome_url', 'core']
  },
  annotations: { title: 'Triage a maintenance photo', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};

// ── plain words for every way the call can fail ──────────────────────────────
// The API's own message is quoted after "The API said:". Each failure has its own sentence: "No key is set here"
// (nothing was sent) reads differently from "refused the key" (401). The host named is the one this server calls
// (FIXRAGENT_API_URL, default fixragent.com). An error body carries `error` either as a code string (fixragent.com)
// or as an object with name and message (the Postman mock); both are read.
function describeFailure(status, body, headers) {
  const errObj = body && body.error && typeof body.error === 'object' ? body.error : null;
  const apiMsg = body && typeof body.message === 'string' ? body.message
    : (errObj && typeof errObj.message === 'string' ? errObj.message : '');
  const code = body && typeof body.error === 'string' ? body.error
    : (errObj && typeof errObj.name === 'string' ? errObj.name : '');
  const retry = headers && headers.get ? headers.get('retry-after') : null;
  const said = apiMsg ? ' The API said: "' + apiMsg + '"' : '';
  const inSecs = retry ? ' Try again in ' + retry + ' seconds (the Retry-After header).' : '';
  switch (status) {
    case 401:
      return API_HOST + ' refused the key (401 ' + (code || 'demo_key_required') + '). Check the value in ' + KEY_ENV +
        '. Request a key at ' + SITE + '/docs#key.' + said;
    case 429:
      if (code === 'demo_key_quota') return 'This demo key has used its 60 requests for today (429). The count resets at 00:00 UTC.' + inSecs + said;
      return 'Too many requests from this address (429). The limit is 20 an hour per address.' + inSecs + said;
    case 413:
      return 'That photo is larger than 3 MB after decoding (413). Send a smaller one.' + said;
    case 415:
      return 'That image format is refused (415): the API strips location metadata and could not clean this one. Send a JPEG, PNG or WebP.' + said;
    case 503:
      return 'The demo has used its compute budget for today (503). This is a limit on our side, not a problem with your photo. The budget resets at 00:00 UTC.' + inSecs + said;
    case 400:
      return API_HOST + ' could not use that request (400' + (code ? ' ' + code : '') + ').' + said;
    case 502:
      return API_HOST + ' could not produce a triage for this photo (502' + (code ? ' ' + code : '') + '). Try once more; if it repeats, the engine is the problem, not your photo.' + said;
    default:
      return API_HOST + ' answered ' + status + (code ? ' ' + code : '') + '.' + said;
  }
}

// ── the call ─────────────────────────────────────────────────────────────────
// image_path is OFF unless FIXRAGENT_IMAGE_DIR names a folder. The tool's arguments are written by a model, and a
// model can be steered by text it read (a prompt injection); with no folder, a path argument could name any file
// this user can read (~/.ssh/id_rsa, a .env) and its bytes would be POSTed to the API. With the folder set, the file's
// real path (symlinks resolved) must be inside it, it must be a regular file of 1 KB to 3 MB, and its first bytes
// must be an image's. image_base64 goes through the same byte check (validatePhotoBytes), so neither door sends
// something that is not a photo.
const IMAGE_DIR_ENV = 'FIXRAGENT_IMAGE_DIR';
const MIN_PHOTO_BYTES = 1024;    // the API refuses photos under 1 KB
const IMAGE_PATH_OFF = 'image_path is switched off on this server, so no file was read and nothing was sent. To let ' +
  'it read photos, set ' + IMAGE_DIR_ENV + ' to the one folder it may read from and restart it; or send the photo as image_base64.';
const OUTSIDE_DIR = 'image_path must name a file inside the folder in ' + IMAGE_DIR_ENV + ' (symlinks are followed ' +
  'and must stay inside it). No file was read and nothing was sent.';

// The first bytes of the image formats a camera or phone produces. Anything else is refused before it is sent.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const g = buf.toString('latin1', 0, 6);
  if (g === 'GIF87a' || g === 'GIF89a') return 'image/gif';
  if (buf.toString('latin1', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].indexOf(buf.toString('latin1', 8, 12)) !== -1) return 'image/heic';
  return null;
}

// One check for both doors: decoded size in bounds, and the bytes begin like an image.
function validatePhotoBytes(buf) {
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'That photo is ' + buf.length + ' bytes; the API takes at most ' + MAX_PHOTO_BYTES + ' (3 MB). Resize it and try again. Nothing was sent.' };
  if (buf.length < MIN_PHOTO_BYTES) return { error: 'That photo is under 1 KB (' + buf.length + ' bytes); the API refuses photos that small. Nothing was sent.' };
  if (!sniffImage(buf)) return { error: 'That is not a photo: its first bytes are not a JPEG, PNG, WebP, GIF or HEIC image. Nothing was sent.' };
  return { base64: buf.toString('base64'), bytes: buf.length };
}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function readPhotoFile(given) {
  const dirEnv = process.env[IMAGE_DIR_ENV];
  if (typeof dirEnv !== 'string' || !dirEnv.trim()) return { error: IMAGE_PATH_OFF };
  const dirGiven = path.resolve(dirEnv.trim());
  let dirReal;
  try { dirReal = fs.realpathSync(dirGiven); } catch (_) { dirReal = null; }
  if (!dirReal || !fs.statSync(dirReal).isDirectory()) {
    return { error: IMAGE_DIR_ENV + ' does not name a folder that exists here, so image_path is off. No file was read and nothing was sent.' };
  }
  // A relative path is taken inside the folder. The lexical check runs before anything touches the disk, so a
  // path outside the folder gets the same sentence whether or not a file is there (no probing for files).
  const p = path.resolve(dirGiven, given);
  if (!isInside(dirGiven, p) && !isInside(dirReal, p)) return { error: OUTSIDE_DIR };
  let real;
  try { real = fs.realpathSync(p); } catch (_) { return { error: 'No file at that path inside ' + IMAGE_DIR_ENV + '. Nothing was sent.' }; }
  if (!isInside(dirReal, real)) return { error: OUTSIDE_DIR };
  let fd;
  try { fd = fs.openSync(real, 'r'); } catch (_) { return { error: 'That file could not be opened. Nothing was sent.' }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: 'That path is not a regular file. Nothing was sent.' };
    if (st.size > MAX_PHOTO_BYTES) return { error: 'That photo is ' + st.size + ' bytes; the API takes at most ' + MAX_PHOTO_BYTES + ' (3 MB). Resize it and try again. Nothing was sent.' };
    if (st.size < MIN_PHOTO_BYTES) return { error: 'That photo is under 1 KB (' + st.size + ' bytes); the API refuses photos that small. Nothing was sent.' };
    const buf = Buffer.alloc(st.size);
    let off = 0, n;
    while (off < buf.length && (n = fs.readSync(fd, buf, off, buf.length - off, off)) > 0) off += n;
    return validatePhotoBytes(buf.subarray(0, off));
  } finally { fs.closeSync(fd); }
}

const B64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_B64_CHARS = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;

function readPhotoBase64(given) {
  // A data: prefix is accepted; line breaks and spaces (a wrapped base64 dump) are removed; what is left must be
  // canonical base64 and nothing else. Buffer.from(…, 'base64') alone would skip any character it does not know.
  const b64 = given.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, '').replace(/[\r\n\t ]+/g, '');
  if (b64.length > MAX_B64_CHARS + 4) return { error: 'That photo decodes to more than ' + MAX_PHOTO_BYTES + ' bytes; the API takes at most 3 MB. Nothing was sent.' };
  if (!B64_STRICT.test(b64)) return { error: 'image_base64 is not base64 (only A-Z, a-z, 0-9, +, / and = padding, in groups of four). Nothing was sent.' };
  return validatePhotoBytes(Buffer.from(b64, 'base64'));
}

function readPhoto(args) {
  const hasPath = typeof args.image_path === 'string' && args.image_path.length > 0;
  const hasB64 = typeof args.image_base64 === 'string' && args.image_base64.length > 0;
  if (hasPath && hasB64) return { error: 'Give image_path or image_base64, not both.' };
  if (!hasPath && !hasB64) return { error: 'A photo is needed: give image_path (a file in the ' + IMAGE_DIR_ENV + ' folder) or image_base64.' };
  return hasPath ? readPhotoFile(args.image_path) : readPhotoBase64(args.image_base64);
}

async function triagePhoto(args) {
  args = args && typeof args === 'object' ? args : {};
  const mime = args.mime_type;
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mime) === -1) {
    return toolError('mime_type must be image/jpeg, image/png or image/webp.');
  }
  const config = args.config === undefined ? 'fast' : args.config;
  if (config !== 'fast' && config !== 'deep') return toolError('config must be "fast" or "deep".');
  const role = args.role === undefined ? 'landlord' : args.role;
  if (role !== 'landlord' && role !== 'fixer') return toolError('role must be "landlord" or "fixer".');
  if (args.problem_text !== undefined && (typeof args.problem_text !== 'string' || args.problem_text.length > MAX_PROBLEM_TEXT)) {
    return toolError('problem_text must be text of at most ' + MAX_PROBLEM_TEXT + ' characters.');
  }
  const key = cleanKey(process.env[KEY_ENV]);
  if (!key) {
    return toolError('No key is set here, so nothing was sent. Put your demo key in the ' + KEY_ENV +
      ' environment variable of this server and start it again. Request a key at ' + SITE + '/docs#key.');
  }
  if (!HEADER_SAFE.test(key)) return toolError(KEY_UNSENDABLE);
  const photo = readPhoto(args);
  if (photo.error) return toolError(photo.error);

  const body = {
    image: photo.base64,
    mimeType: mime,
    reporter: role === 'fixer' ? 'technician' : 'resident',
    role: role,
    variant: 'source:mcp'
  };
  if (typeof args.problem_text === 'string' && args.problem_text.trim()) body.problem_text = args.problem_text.trim();

  let res;
  try {
    res = await fetch(API_BASE + '/api/triage?config=' + config, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triage-key': key, 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
  } catch (e) {
    // e.message is never quoted: for a header problem Node writes the header value (the key) into it.
    if (e && e.name === 'TimeoutError') return toolError('Could not reach ' + API_BASE + ' (no reply within ' + (CALL_TIMEOUT_MS / 1000) + ' seconds). Check the network and try again.');
    if (/header/i.test(String(e && e.message))) return toolError(KEY_UNSENDABLE);
    return toolError('Could not reach ' + API_BASE + ' (' + networkCode(e) + '). Check the network and try again.');
  }
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (res.status !== 200) return toolError(describeFailure(res.status, json, res.headers));
  if (!json || typeof json !== 'object' || typeof json.diagnosis_id !== 'string' || !json.core) {
    return toolError(API_HOST + ' answered 200 but the reply was not the triage shape (no diagnosis_id or core). Try once more.');
  }
  const out = Object.assign({}, json, {
    share_url: SITE + '/c/' + json.diagnosis_id,
    outcome_url: SITE + '/o/' + json.diagnosis_id
  });
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}

function toolError(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

// ── JSON-RPC over stdio, both eras ───────────────────────────────────────────
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function log(s) { if (process.env.FIXRAGENT_MCP_DEBUG) process.stderr.write('[fixragent-mcp] ' + s + '\n'); }
function rpcError(id, code, message, data) {
  const e = { code: code, message: message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: e };
}

let legacyInitialized = false;

async function handleRequest(req) {
  const id = req.id;
  const params = req.params && typeof req.params === 'object' ? req.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : null;
  const modern = !!(meta && typeof meta[META_VERSION] === 'string');

  if (modern) {
    const v = meta[META_VERSION];
    if (MODERN_VERSIONS.indexOf(v) === -1) {
      return rpcError(id, -32022, 'Unsupported protocol version', { supported: MODERN_VERSIONS, requested: v });
    }
    if (!meta[META_CLIENT_CAPS] || typeof meta[META_CLIENT_CAPS] !== 'object') {
      return rpcError(id, -32602, 'Invalid params: _meta.' + META_CLIENT_CAPS + ' is required on every request');
    }
  }
  const finish = (result) => {
    if (modern || req.method === 'server/discover') {
      result.resultType = 'complete';
      result._meta = Object.assign({}, result._meta, { [META_SERVER_INFO]: { name: SERVER.name, version: SERVER.version } });
    }
    return { jsonrpc: '2.0', id: id, result: result };
  };

  switch (req.method) {
    case 'server/discover':
      return finish({ supportedVersions: MODERN_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    case 'initialize': {
      if (modern) return rpcError(id, -32601, 'initialize is a legacy method; this request already carries per-request _meta');
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = LEGACY_VERSIONS.indexOf(asked) !== -1 ? asked : LEGACY_VERSIONS[0];
      return finish({
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return finish({});
    case 'tools/list':
      if (!modern && !legacyInitialized) log('tools/list before initialize; answering anyway');
      return finish({ tools: [TOOL] });
    case 'tools/call': {
      if (params.name !== TOOL.name) return rpcError(id, -32602, 'Unknown tool: ' + String(params.name));
      const result = await triagePhoto(params.arguments);
      return finish(result);
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + String(req.method));
  }
}

function handleNotification(msg) {
  if (msg.method === 'notifications/initialized') { legacyInitialized = true; log('client initialized'); }
  // notifications/cancelled: a triage call cannot be un-sent; nothing further is written for that id (the reply
  // is still written once, which legacy clients tolerate). Other notifications are ignored, as the spec allows.
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid Request');
  if (msg.jsonrpc !== '2.0') return rpcError(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  if (typeof msg.method === 'string') {
    if (msg.id === undefined) { handleNotification(msg); return null; }
    if (msg.id === null || (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return rpcError(null, -32600, 'Invalid Request: id must be a string or a number');
    try { return await handleRequest(msg); } catch (e) { return rpcError(msg.id, -32603, 'Internal error: ' + ((e && e.message) || 'unknown')); }
  }
  return null; // a response to a request this server never sends
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { write(rpcError(null, -32700, 'Parse error')); return; }
    chain = chain.then(async () => {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) { write(rpcError(null, -32600, 'Invalid Request: empty batch')); return; }
        const out = [];
        for (const m of parsed) { const r = await handleMessage(m); if (r) out.push(r); }
        if (out.length) write(out);
        return;
      }
      const r = await handleMessage(parsed);
      if (r) write(r);
    });
  });
  rl.on('close', () => { chain.then(() => process.exit(0)); });
  process.stdin.on('error', () => process.exit(0));
}

// ── a human at the terminal ──────────────────────────────────────────────────
async function selfCheck() {
  const key = cleanKey(process.env[KEY_ENV]);
  process.stdout.write(KEY_ENV + ': ' + (!key ? 'NOT set — request a key at ' + SITE + '/docs#key'
    : HEADER_SAFE.test(key) ? 'set' : 'set, but it holds a character a request header cannot carry; set it again as one line') + '\n');
  try {
    const r = await fetch(API_BASE + '/openapi.json', { method: 'GET', signal: AbortSignal.timeout(15000), headers: { 'user-agent': USER_AGENT } });
    process.stdout.write(API_BASE + '/openapi.json: ' + r.status + '\n');
  } catch (e) {
    process.stdout.write(API_BASE + ': not reachable (' + networkCode(e) + ')\n');
  }
  process.stdout.write('protocol: legacy ' + LEGACY_VERSIONS.join(', ') + ' and modern ' + MODERN_VERSIONS.join(', ') + '\n');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
    process.stdout.write(
      'fixragent-mcp ' + SERVER.version + ' — one MCP tool, triage_photo, over stdio.\n' +
      'Run it from an MCP client (Claude Desktop, Claude Code, Cursor); see README.md.\n' +
      '  --check   say whether ' + KEY_ENV + ' is set and whether ' + API_BASE + ' answers\n' +
      '  --version print the version\n');
    process.exit(0);
  }
  if (argv.indexOf('--version') !== -1) { process.stdout.write(SERVER.version + '\n'); process.exit(0); }
  if (argv.indexOf('--check') !== -1) { selfCheck().then(() => process.exit(0)); }
  else serve();
}

module.exports = { sniffImage, validatePhotoBytes, IMAGE_DIR_ENV, TOOL, CORE_PROPERTIES, describeFailure, cleanKey, handleMessage, MODERN_VERSIONS, LEGACY_VERSIONS, SERVER };
