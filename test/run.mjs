#!/usr/bin/env node
/**
 * mcp/test/run.mjs — spawns server.js and talks to it the way a real client does.
 *
 *   node test/run.mjs                 stub mode: a local HTTP stub replays captured API replies (no spend, no rows)
 *   node test/run.mjs --live [--photo p.jpg]
 *                                     adds two production calls: a wrong key (401, spends nothing, stores nothing)
 *                                     and one real triage with FIXRAGENT_API_KEY from the environment (≈ one cent)
 *   MCP_TEST_CANARY=401-as-200 node test/run.mjs    the stub answers 200 to a wrong key → the 401 case MUST go red
 *   MCP_TEST_CANARY=drop-core  node test/run.mjs    the stub drops a core field → the shape case MUST go red
 *
 * Two clients are used on purpose: the official SDK (@modelcontextprotocol/sdk 1.30.0, legacy `initialize` era,
 * which also validates structuredContent against the tool's outputSchema) and raw JSON-RPC lines for the modern
 * 2026-07-28 era (`server/discover`, per-request _meta), which the SDK does not speak yet.
 *
 * The key never appears in this file or its output. In --live mode it is read from process.env and handed to
 * the child; a test line prints only whether it was set.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// MCP_TEST_SERVER runs the same cases against another copy (a before-fix copy, a planted copy) — rule 8.
const SERVER_JS = process.env.MCP_TEST_SERVER ? path.resolve(process.env.MCP_TEST_SERVER) : path.join(HERE, '..', 'server.js');
const FIX = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));
const OPENAPI = path.join(HERE, '..', '..', 'openapi.json');
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const PHOTO = argv.includes('--photo') ? argv[argv.indexOf('--photo') + 1] : null;
const CANARY = process.env.MCP_TEST_CANARY || '';

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (cond || !extra ? '' : '\n      ' + extra));
  cond ? pass++ : fail++;
};

// ── the stub API: replays captured replies, decides by the key ──────────────
function startStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { body = {}; }
      const url = new URL(req.url, 'http://stub');
      const key = req.headers['x-triage-key'];
      requests.push({
        url: req.url, key: key, config: url.searchParams.get('config'),
        has_image: typeof body.image === 'string', image_len: (body.image || '').length,
        mimeType: body.mimeType, reporter: body.reporter, role: body.role, variant: body.variant, problem_text: body.problem_text
      });
      let fx;
      if (key === 'stub-key' || (CANARY === '401-as-200' && key === 'wrong-key')) {
        const decoded = Math.floor(((body.image || '').length * 3) / 4);
        fx = decoded > 3145728 ? FIX('413-image_too_large.json') : (url.searchParams.get('config') === 'deep' ? FIX('deep-200.json') : FIX('fast-200.json'));
        if (CANARY === 'drop-core' && fx.status === 200) delete fx.body.core.trade_required;
      } else if (key === 'quota-key') {
        // No captured 429 in the collection; message VERBATIM from api/triage.js ERRORS.demo_key_quota (line 148).
        fx = { status: 429, headers: { 'retry-after': '3600', 'content-type': 'application/json; charset=utf-8' },
          body: { error: 'demo_key_quota', message: 'This demo key has used its 60 requests for today. The count resets at 00:00 UTC; the Retry-After header on this response says how many seconds that is.', retry_after_seconds: 3600, retry_after_basis: 'utc_day' } };
      } else if (key === 'mockshape') {
        // The Postman mock's refusal of a body over 1 MB, VERBATIM (RECORD T2c/refute/mock-reply-fault02-2.1MB.json): `error` is an object.
        fx = { status: 400, headers: { 'content-type': 'application/json' }, body: { error: { name: 'badRequest', message: 'The request body sent by you exceeds the 1mb size limit.' } } };
      } else if (key === 'fuse-key') {
        fx = FIX('503-budget_exhausted.json');
      } else {
        fx = FIX('401-demo_key_required.json');
      }
      res.writeHead(fx.status, fx.headers || { 'content-type': 'application/json' });
      res.end(JSON.stringify(fx.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port, requests, close: () => server.close()
  })));
}

// ── clients ──────────────────────────────────────────────────────────────────
function childEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  return Object.assign(env, extra);
}
async function withSdk(env, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_JS], env: childEnv(env), stderr: 'pipe' });
  const client = new Client({ name: 'fixragent-mcp-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
function rawSession(env) {
  const child = spawn(process.execPath, [SERVER_JS], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  return {
    send: (msg) => new Promise((resolve, reject) => {
      pending.set(msg.id, resolve);
      child.stdin.write(JSON.stringify(msg) + '\n');
      setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); reject(new Error('no reply to ' + msg.id)); } }, 15000);
    }),
    notify: (msg) => child.stdin.write(JSON.stringify(msg) + '\n'),
    end: () => new Promise((resolve) => { child.on('exit', (code) => resolve(code)); child.stdin.end(); })
  };
}
// one tools/call on a fresh process, stdout and stderr both kept, so a leak on either stream is visible
function rawCall(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_JS], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', () => {
      clearTimeout(t);
      let result = null;
      out.split('\n').filter(Boolean).forEach((l) => { try { const m = JSON.parse(l); if (m.id === 2) result = m.result || null; } catch (_) {} });
      resolve({ out, err, result });
    });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'triage_photo', arguments: args } }
    ].map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
}
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw-test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

// ── a photo the stub will accept (it never looks at the bytes) ──────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixragent-mcp-test-'));
const smallPhoto = path.join(tmp, 'photo.jpg');
fs.writeFileSync(smallPhoto, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 1)]));
const bigPhoto = path.join(tmp, 'big.jpg');
fs.writeFileSync(bigPhoto, Buffer.alloc(3145729, 2));

// ── the cases ────────────────────────────────────────────────────────────────
async function stubCases() {
  const stub = await startStub();
  const base = { FIXRAGENT_API_URL: stub.url };
  const call = (client, args) => client.callTool({ name: 'triage_photo', arguments: args });

  console.log('# stub mode — ' + stub.url + (CANARY ? '   CANARY=' + CANARY + ' (a case MUST go red)' : ''));

  // tools/list through the SDK
  await withSdk(base, async (client) => {
    const list = await client.listTools();
    const t = list.tools[0];
    ok(list.tools.length === 1 && t.name === 'triage_photo', 'tools/list: exactly one tool, triage_photo');
    ok(typeof t.title === 'string' && t.annotations && t.annotations.readOnlyHint === false && t.annotations.destructiveHint === false, 'tool carries title and readOnlyHint/destructiveHint annotations');
    ok(t.inputSchema && Array.isArray(t.inputSchema.required) && t.inputSchema.required.join() === 'mime_type', 'inputSchema requires mime_type only');
    ok(t.outputSchema && t.outputSchema.properties && t.outputSchema.properties.core, 'outputSchema declares core');
  });

  // RED A — no key set → plain words, nothing sent
  await withSdk(base, async (client) => {
    await client.listTools();
    const before = stub.requests.length;
    const r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg' });
    ok(r.isError === true && /No key is set here/.test(text(r)) && /FIXRAGENT_API_KEY/.test(text(r)), 'RED A: key absent → "No key is set here…" in plain words', text(r));
    ok(stub.requests.length === before, 'RED A: nothing was sent to the API');
  });

  // RED B — wrong key → 401 surfaced with the API's own sentence
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'wrong-key' }, base), async (client) => {
    await client.listTools();
    const r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg' });
    ok(r.isError === true && /401/.test(text(r)) && /A demo key is required\. Send it as the x-triage-key header\./.test(text(r)),
      'RED B: wrong key → 401 in plain words, the API\'s message quoted', text(r));
  });

  // RED C — daily quota → 429 with the seconds from Retry-After
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'quota-key' }, base), async (client) => {
    await client.listTools();
    const r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg' });
    ok(r.isError === true && /60 requests/.test(text(r)) && /Try again in 3600 seconds/.test(text(r)), 'RED C: quota → 429, "60 requests", Retry-After seconds', text(r));
  });

  // RED D — the fuse → 503 in plain words with the seconds
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'fuse-key' }, base), async (client) => {
    await client.listTools();
    const r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg' });
    ok(r.isError === true && /503/.test(text(r)) && /compute budget/.test(text(r)) && /Try again in 57600 seconds/.test(text(r)), 'RED D: fuse → 503 plain words, Retry-After seconds', text(r));
  });

  // RED E — a 3 MB + 1 byte photo is refused before anything is sent
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'stub-key' }, base), async (client) => {
    await client.listTools();
    const before = stub.requests.length;
    const r = await call(client, { image_path: bigPhoto, mime_type: 'image/jpeg' });
    ok(r.isError === true && /3145728/.test(text(r)) && stub.requests.length === before, 'RED E: oversize photo refused locally, nothing sent', text(r));
    const r2 = await call(client, { mime_type: 'image/jpeg' });
    ok(r2.isError === true && /A photo is needed/.test(text(r2)), 'RED E2: no photo at all → plain words', text(r2));
    const r3 = await call(client, { image_path: smallPhoto, mime_type: 'image/gif' });
    ok(r3.isError === true && /mime_type must be/.test(text(r3)), 'RED E3: unsupported mime_type → plain words', text(r3));
  });

  // RED F — an error body whose `error` is an object (the Postman mock's 1 MB refusal) → name and message read, the called host named
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'mockshape' }, base), async (client) => {
    await client.listTools();
    const r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg' });
    const host = new URL(stub.url).host;
    ok(r.isError === true && text(r).indexOf(host + ' could not use that request (400 badRequest).') === 0 && /1mb size limit/.test(text(r)),
      'RED F: object-shaped error body → its name and message are read, and the host named is the one called (' + host + ')', text(r));
  });

  // RED G — a key with a line break inside is refused before any request; the key is in neither stdout nor stderr (debug on)
  {
    const KEYV = 'LEAKCHECK-7f3a9c';
    const before = stub.requests.length;
    const got = await rawCall(Object.assign({ FIXRAGENT_API_KEY: KEYV + '\nsecond-line', FIXRAGENT_MCP_DEBUG: '1' }, base), { image_path: smallPhoto, mime_type: 'image/jpeg' });
    ok(got.result && got.result.isError === true && /cannot carry/.test(text(got.result)) && stub.requests.length === before,
      'RED G: a key with a line break inside → a fixed sentence, nothing sent', text(got.result));
    ok(got.out.indexOf(KEYV) === -1 && got.err.indexOf(KEYV) === -1, 'RED G: the key value is absent from stdout and stderr', text(got.result));
  }

  // GREEN — a key pasted with quotes, a zero-width space and a trailing space is cleaned the way api/triage.js cleans it
  {
    const got = await rawCall(Object.assign({ FIXRAGENT_API_KEY: '"stub-key"\u200b ' }, base), { image_path: smallPhoto, mime_type: 'image/jpeg' });
    const last = stub.requests[stub.requests.length - 1];
    ok(got.result && !got.result.isError && last && last.key === 'stub-key', 'GREEN: a pasted key with quotes and a zero-width space is sent as the bare key', text(got.result));
  }

  // GREEN — right key → the contract shape, share_url, variant source:mcp
  await withSdk(Object.assign({ FIXRAGENT_API_KEY: 'stub-key' }, base), async (client) => {
    await client.listTools();
    let r, err = null;
    try { r = await call(client, { image_path: smallPhoto, mime_type: 'image/jpeg', problem_text: 'Water on the floor under the heater.' }); }
    catch (e) { err = e; }
    ok(!err, 'GREEN: the SDK accepted the result against outputSchema (no validation error)', err && err.message);
    const sc = r && r.structuredContent;
    ok(r && !r.isError && sc && typeof sc.diagnosis_id === 'string', 'GREEN: 200 → structuredContent with diagnosis_id');
    const coreKeys = sc ? Object.keys(sc.core || {}) : [];
    ok(coreKeys.length === 20, 'GREEN: core has 20 fields (' + coreKeys.length + ')');
    ok(sc && sc.share_url === 'https://fixragent.com/c/' + sc.diagnosis_id && sc.outcome_url === 'https://fixragent.com/o/' + sc.diagnosis_id, 'GREEN: share_url and outcome_url are built from diagnosis_id');
    ok(sc && sc.agreement && sc.agreement.n === 3 && sc.agreement.k === 3, 'GREEN: fast reply carries agreement.n = 3, k = 3 (walk 2 production reply, 14 Sep)');
    ok(sc && ['EMERGENCY', 'TODAY', 'THIS WEEK', 'WHENEVER'].includes(sc.core.tier), 'GREEN: tier is one of the four words (' + (sc && sc.core.tier) + ')');
    let parsed = null; try { parsed = JSON.parse(text(r)); } catch (_) {}
    ok(parsed && JSON.stringify(parsed) === JSON.stringify(sc), 'GREEN: the text block is the same JSON as structuredContent');
    const last = stub.requests[stub.requests.length - 1];
    ok(last && last.variant === 'source:mcp' && last.role === 'landlord' && last.reporter === 'resident' && last.mimeType === 'image/jpeg' && last.has_image && last.config === 'fast',
      'GREEN: the request carried variant source:mcp, role landlord, reporter resident, config=fast', JSON.stringify(last));
    ok(last && last.problem_text === 'Water on the floor under the heater.', 'GREEN: problem_text passed through verbatim');

    const r2 = await call(client, { image_path: smallPhoto, mime_type: 'image/png', role: 'fixer', config: 'deep' });
    const last2 = stub.requests[stub.requests.length - 1];
    ok(!r2.isError && last2.role === 'fixer' && last2.reporter === 'technician' && last2.config === 'deep', 'GREEN: role fixer → reporter technician; config=deep on the query string');
    ok(r2.structuredContent && r2.structuredContent.agreement && r2.structuredContent.agreement.n === 5, 'GREEN: deep reply carries agreement.n = 5 (five reads, the captured deep reply on main)');

    const b64 = fs.readFileSync(smallPhoto).toString('base64');
    const r3 = await call(client, { image_base64: 'data:image/jpeg;base64,' + b64, mime_type: 'image/jpeg' });
    const last3 = stub.requests[stub.requests.length - 1];
    ok(!r3.isError && last3.image_len === b64.length, 'GREEN: image_base64 with a data: prefix is accepted and the prefix stripped');
  });

  // contract drift — CORE_PROPERTIES vs openapi.json (in-repo only)
  if (fs.existsSync(OPENAPI)) {
    const spec = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));
    const { CORE_PROPERTIES } = await import(SERVER_JS).then((m) => m.default || m);
    const specKeys = Object.keys(spec.components.schemas.TriageCore.properties);
    const mine = Object.keys(CORE_PROPERTIES);
    ok(specKeys.join() === mine.join(), 'contract: outputSchema core fields equal openapi.json TriageCore, in order (' + mine.length + ')');
    const specTier = spec.components.schemas.TriageCore.properties.tier.enum.join();
    ok(specTier === CORE_PROPERTIES.tier.enum.join(), 'contract: tier enum matches openapi.json');
    ok(spec.components.schemas.TriageCore.properties.severity.enum.join() === CORE_PROPERTIES.severity.enum.join(), 'contract: severity enum matches openapi.json');
  } else {
    console.log('SKIP  contract drift check: openapi.json not beside this package');
  }

  // modern era, raw JSON-RPC
  {
    const s = rawSession(Object.assign({ FIXRAGENT_API_KEY: 'stub-key' }, base));
    const d = await s.send({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: META } });
    ok(d.result && d.result.resultType === 'complete' && d.result.supportedVersions.includes('2026-07-28') && d.result._meta && d.result._meta['io.modelcontextprotocol/serverInfo'].name === 'fixragent-mcp',
      'modern: server/discover → resultType complete, supportedVersions has 2026-07-28, serverInfo in _meta');
    const bad = await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: Object.assign({}, META, { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }) } });
    ok(bad.error && bad.error.code === -32022 && Array.isArray(bad.error.data.supported), 'modern: unknown version → -32022 UnsupportedProtocolVersion with data.supported');
    const noCaps = await s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    ok(noCaps.error && noCaps.error.code === -32602, 'modern: missing clientCapabilities → -32602');
    const lst = await s.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: META } });
    ok(lst.result && lst.result.resultType === 'complete' && lst.result.tools[0].name === 'triage_photo', 'modern: tools/list → resultType complete');
    const c = await s.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'triage_photo', arguments: { image_path: smallPhoto, mime_type: 'image/jpeg' }, _meta: META } });
    ok(c.result && c.result.resultType === 'complete' && c.result.structuredContent && c.result.structuredContent.share_url, 'modern: tools/call → resultType complete + structuredContent');
    const unk = await s.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'other_tool', arguments: {}, _meta: META } });
    ok(unk.error && unk.error.code === -32602, 'protocol error: unknown tool → -32602 (not a tool result)');
    // legacy negotiation on the same process: an unknown legacy version gets the newest legacy version back
    const init = await s.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '1900-01-01', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    ok(init.result && init.result.protocolVersion === '2025-11-25' && init.result.capabilities.tools, 'legacy: unknown protocolVersion → the server answers 2025-11-25');
    const t0 = Date.now();
    const code = await s.end();
    ok(code === 0 && Date.now() - t0 < 3000, 'stdio: server exits 0 promptly when stdin closes (' + (Date.now() - t0) + ' ms)');
  }

  stub.close();
}

async function liveCases() {
  console.log('# live mode — production https://fixragent.com (two calls: a wrong key, then one real triage)');
  const keySet = !!(process.env.FIXRAGENT_API_KEY && process.env.FIXRAGENT_API_KEY.trim());
  ok(keySet, 'live: FIXRAGENT_API_KEY is set in this environment (value never printed)');
  const photo = PHOTO || smallPhoto;
  const call = (client, args) => client.callTool({ name: 'triage_photo', arguments: args });

  await withSdk({ FIXRAGENT_API_KEY: 'this-is-not-the-key' }, async (client) => {
    await client.listTools();
    const r = await call(client, { image_path: photo, mime_type: 'image/jpeg' });
    ok(r.isError === true && /401/.test(text(r)) && /A demo key is required/.test(text(r)), 'LIVE RED: production refuses a wrong key with 401 in plain words (spends nothing, stores nothing)', text(r));
  });
  if (!keySet) { console.log('SKIP  live GREEN: no key in the environment'); return; }
  await withSdk({ FIXRAGENT_API_KEY: process.env.FIXRAGENT_API_KEY }, async (client) => {
    await client.listTools();
    const t0 = Date.now();
    let r, err = null;
    try { r = await call(client, { image_path: photo, mime_type: 'image/jpeg', problem_text: 'Tenant sent this photo and says it is leaking.' }); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok(!err, 'LIVE GREEN: the SDK accepted the production reply against outputSchema', err && err.message);
    const sc = r && r.structuredContent;
    ok(r && !r.isError && sc && typeof sc.diagnosis_id === 'string' && Object.keys(sc.core || {}).length === 20, 'LIVE GREEN: production 200 → diagnosis_id + 20 core fields in ' + ms + ' ms', text(r).slice(0, 300));
    if (sc) {
      console.log('LIVE  diagnosis_id=' + sc.diagnosis_id + ' config_id=' + sc.config_id + ' engine=' + sc.engine_version + ' rubric=' + sc.rubric_version +
        ' tier=' + sc.core.tier + ' asset=' + JSON.stringify(sc.core.asset_type) + ' fault_detected=' + sc.core.fault_detected + ' share_url=' + sc.share_url +
        ' stored=' + JSON.stringify(sc.stored) + ' fallback=' + (sc.config_source && sc.config_source.fallback_used));
      console.log('SPEND one fast production triage ≈ $0.01 COMPUTED (BLOCK-157 COMMON §7: FAST ≈ $0.01 from the run-2 config); log it in spend.jsonl');
    }
  });
}

try {
  await stubCases();
  if (LIVE) await liveCases();
} catch (e) {
  console.log('FAIL  harness threw: ' + (e && e.stack || e));
  fail++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\n' + pass + ' pass, ' + fail + ' fail' + (CANARY ? '  (canary ' + CANARY + ': ' + (fail ? 'went RED as it must' : 'DID NOT go red — the harness is decoration') + ')' : ''));
process.exit(fail ? 1 : 0);
