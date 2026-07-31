// release-publisher.mjs
//
// Firmware release publisher.
// Ye script 5 kaam karti hai:
//   1. build_manifest.csv ko DuckDB me load karke SQL se reconcile karna
//      (duplicates hatana, withdrawn builds hatana, publishable bundles nikalna)
//   2. Har publishable bundle ka descriptor bana ke, current (nayi) signing key
//      se OpenSSL CMS detached signature banana
//   3. Signed bundle ko distribution-gateway ko HTTP POST karna
//   4. Receipt + idempotency token ko DuckDB me save karna (dobara run pe
//      duplicate publish na ho)
//   5. Fixed format me deterministic output print karna

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import duckdb from 'duckdb';

// ---------------------------------------------------------------------------
// CONFIG — sab kuch environment variables se override ho sakta hai.
// Docker/grader environment me defaults already sahi hain (/app/...).
// Windows pe native testing ke liye, in env vars ko apne local paths pe set
// karo (README dekho neeche).
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:7070';

// Publisher jis cert/key se sign karega (hamesha CURRENT key, revoked nahi).
const CURRENT_CERT_PATH =
  process.env.PUBLISHER_CURRENT_CERT || '/app/keys/current/current.cert.pem';
const CURRENT_KEY_PATH =
  process.env.PUBLISHER_CURRENT_KEY || '/app/keys/current/current.key.pem';

// Manifest CSV kahan hai (default: npm run report jis folder se chalta hai,
// wahan ka fixtures/build_manifest.csv).
const MANIFEST_PATH =
  process.env.MANIFEST_PATH ||
  path.join(process.cwd(), 'fixtures', 'build_manifest.csv');

// DuckDB database file — pehli baar run pe khud ban jayegi.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'releases.duckdb');

// ---------------------------------------------------------------------------
// DuckDB ko Promise-based bana dete hain, taaki async/await se kaam kar sakein
// (duckdb npm package callback-style hai).
// ---------------------------------------------------------------------------

function run(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
  });
}

function all(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ---------------------------------------------------------------------------
// Canonical JSON encoding — bilkul wahi tarika jo gateway khud use karta hai
// (lib/signature-verify.js ki canonicalEncode se match hona zaroori hai):
// keys alphabetically sorted, koi extra space nahi.
// ---------------------------------------------------------------------------

function canonicalEncode(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalEncode).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalEncode(value[k]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// OpenSSL se detached CMS signature banana (current key se, revoked se KABHI nahi).
// ---------------------------------------------------------------------------

function signDescriptor(descriptorBytes) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-'));
  const descriptorFile = path.join(scratch, 'descriptor.bin');
  try {
    fs.writeFileSync(descriptorFile, descriptorBytes);
    // Note: -nodetach NAHI lagana — gateway detached signature expect karta
    // hai (-content flag se verify karta hai).
    const sigPem = execFileSync(
      'openssl',
      [
        'cms',
        '-sign',
        '-in', descriptorFile,
        '-signer', CURRENT_CERT_PATH,
        '-inkey', CURRENT_KEY_PATH,
        '-outform', 'PEM',
        '-binary',
      ],
      { encoding: 'utf8' }
    );
    return sigPem;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Gateway se signing key info fetch karna.
// ---------------------------------------------------------------------------

async function fetchCurrentSigningKey() {
  const res = await fetch(`${GATEWAY_URL}/v1/signing-key/current`);
  if (!res.ok) {
    throw new Error(`GET /v1/signing-key/current failed: HTTP ${res.status}`);
  }
  return res.json(); // { key_id, algorithm, certificate_ref, status }
}

// ---------------------------------------------------------------------------
// Gateway ko signed bundle POST karna.
// ---------------------------------------------------------------------------

async function submitPublication(descriptorString, signaturePem, requestToken) {
  const res = await fetch(`${GATEWAY_URL}/v1/publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      descriptor: descriptorString,
      signature: signaturePem,
      request_token: requestToken,
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(
      `Publication rejected for token ${requestToken}: ${body.error || res.status} ${
        body.message || ''
      }`
    );
  }
  return body; // { publication_id, request_token, status }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = new duckdb.Database(DB_PATH);
  const conn = db.connect();

  // --- Ledger table: idempotency ke liye. Agar pehle se hai to CREATE IF NOT
  // EXISTS kuch nahi karega, purana data safe rahega. ---
  await run(
    conn,
    `CREATE TABLE IF NOT EXISTS publication_ledger (
       bundle_id VARCHAR PRIMARY KEY,
       request_token VARCHAR,
       publication_id VARCHAR,
       key_id VARCHAR
     )`
  );

  // --- Manifest CSV ko har run pe fresh load karte hain (raw input hai,
  // reconciliation state persist karne ki zaroorat nahi — sirf ledger
  // persist hota hai). ---
  const escapedManifestPath = MANIFEST_PATH.replace(/'/g, "''");
  await run(
    conn,
    `CREATE OR REPLACE TABLE manifest AS
     SELECT * FROM read_csv(
       '${escapedManifestPath}',
       columns = {
         'entry_id': 'VARCHAR',
         'bundle_id': 'VARCHAR',
         'component_id': 'VARCHAR',
         'version': 'VARCHAR',
         'size_bytes': 'BIGINT',
         'record_type': 'VARCHAR',
         'supersedes_id': 'VARCHAR',
         'recorded_at': 'VARCHAR'
       },
       header = true
     )`
  );

  // --- Reconciliation SQL ---
  // 1) Exact duplicate rows collapse karo (SELECT DISTINCT).
  // 2) WITHDRAWAL rows jo entry_id cancel karti hain unhe nikaal ke set banao.
  // 3) Sirf wahi BUILD rows rakho jo withdraw nahi hui.
  // 4) Bundle-wise group karke artifact_count + total_bytes nikalo.
  // 5) bundle_id ke ascending order me sort karo.
  const bundles = await all(
    conn,
    `WITH deduped AS (
       SELECT DISTINCT
         entry_id, bundle_id, component_id, version,
         size_bytes, record_type, supersedes_id, recorded_at
       FROM manifest
     ),
     withdrawn AS (
       SELECT DISTINCT supersedes_id AS entry_id
       FROM deduped
       WHERE record_type = 'WITHDRAWAL'
         AND supersedes_id IS NOT NULL
         AND supersedes_id <> ''
     ),
     surviving_builds AS (
       SELECT d.*
       FROM deduped d
       WHERE d.record_type = 'BUILD'
         AND d.entry_id NOT IN (SELECT entry_id FROM withdrawn)
     )
     SELECT
       bundle_id,
       COUNT(*)::BIGINT AS artifact_count,
       SUM(size_bytes)::BIGINT AS total_bytes
     FROM surviving_builds
     GROUP BY bundle_id
     ORDER BY bundle_id`
  );

  // --- Gateway se current signing key ka pata karo ---
  const signingKey = await fetchCurrentSigningKey();

  const outputLines = [];

  for (const bundle of bundles) {
    const bundleId = bundle.bundle_id;
    const requestToken = `token-${bundleId}`;

    // --- Idempotency check: agar pehle se publish ho chuka hai, to dobara
    // sign/POST mat karo — stored values hi use karo. ---
    const existing = await all(
      conn,
      `SELECT bundle_id, request_token, publication_id, key_id
       FROM publication_ledger WHERE bundle_id = ?`,
      [bundleId]
    );

    let publicationId;
    let keyId;

    if (existing.length > 0) {
      publicationId = existing[0].publication_id;
      keyId = existing[0].key_id;
    } else {
      // Descriptor banao — canonical JSON (sorted keys, no whitespace).
      const descriptorObj = {
        artifact_count: Number(bundle.artifact_count),
        bundle_id: bundleId,
        total_bytes: Number(bundle.total_bytes),
      };
      const descriptorString = canonicalEncode(descriptorObj);
      const descriptorBytes = Buffer.from(descriptorString, 'utf8');

      // Sign karo current key se.
      const signaturePem = signDescriptor(descriptorBytes);

      // Gateway ko POST karo.
      const receipt = await submitPublication(descriptorString, signaturePem, requestToken);

      publicationId = receipt.publication_id;
      keyId = signingKey.key_id;

      // DuckDB me save karo (idempotency ke liye).
      await run(
        conn,
        `INSERT INTO publication_ledger (bundle_id, request_token, publication_id, key_id)
         VALUES (?, ?, ?, ?)`,
        [bundleId, requestToken, publicationId, keyId]
      );
    }

    outputLines.push(`BUNDLE ${bundleId} SIGNED KEY=${keyId}`);
    outputLines.push(
      `BUNDLE ${bundleId} PUBLISHED RECEIPT=${publicationId} TOKEN=${requestToken} STATUS=PUBLISHED`
    );
  }

  console.log(outputLines.join('\n'));

  conn.close();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
