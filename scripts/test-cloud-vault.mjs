#!/usr/bin/env node
/**
 * Cloud Vault Proxy Test
 *
 * Confirms the vault at VAULT_URL works as an HTTPS CONNECT proxy.
 * Tests: proxy reachability, pip (pypi.org), GitHub API, npm registry, CA cert.
 *
 * Usage:
 *   VAULT_URL=https://cloud-vault-production-6ab6.up.railway.app \
 *   VAULT_TOKEN=<inspect-token> \
 *   node scripts/test-cloud-vault.mjs
 *
 * The proxy must be reachable via HTTP CONNECT tunneling. Set VAULT_URL to
 * the base URL of the vault service (Railway, localhost, etc.).
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const VAULT_URL = process.env.VAULT_URL ?? "https://cloud-vault-production-6ab6.up.railway.app";
// VAULT_PROXY_TOKEN — for CONNECT proxy auth (Proxy-Authorization: Basic)
// VAULT_INSPECT_TOKEN — for /interceptions endpoint (X-Vault-Inspect-Token)
// VAULT_TOKEN — fallback for both if specific vars not set
const VAULT_TOKEN = process.env.VAULT_TOKEN ?? "";
const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN ?? VAULT_TOKEN;
const VAULT_INSPECT_TOKEN = process.env.VAULT_INSPECT_TOKEN ?? VAULT_TOKEN;
// cloud-vault uses Basic auth for CONNECT: Proxy-Authorization: Basic base64(x:TOKEN)
const PROXY_AUTH_HEADER = VAULT_PROXY_TOKEN
  ? `Basic ${Buffer.from(`x:${VAULT_PROXY_TOKEN}`).toString("base64")}`
  : "";
const parsed = new URL(VAULT_URL);
const PROXY_HOST = parsed.hostname;
const PROXY_PORT = parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
const PROXY_HTTPS = parsed.protocol === "https:";

const results = [];
function pass(name, detail = "") { results.push({ name, ok: true }); console.log(`✅ ${name}${detail ? ": " + detail : ""}`); }
function fail(name, detail = "") { results.push({ name, ok: false }); console.log(`❌ ${name}${detail ? ": " + detail : ""}`); }
function info(msg) { console.log(`ℹ️  ${msg}`); }

/** Open a TCP tunnel through the proxy via HTTP CONNECT */
function connectTunnel(targetHost, targetPort = 443) {
  return new Promise((resolve, reject) => {
    const proxyHeaders = {
      Host: `${targetHost}:${targetPort}`,
      ...(PROXY_AUTH_HEADER ? { "Proxy-Authorization": PROXY_AUTH_HEADER } : {}),
    };

    const connectFn = PROXY_HTTPS ? https.request : http.request;
    const req = connectFn({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: proxyHeaders,
      rejectUnauthorized: false, // proxy cert may be self-signed
      timeout: 10_000,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) resolve({ socket, res });
      else { socket.destroy(); reject(new Error(`CONNECT ${res.statusCode}`)); }
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("CONNECT timeout")); });
    req.end();
  });
}

/** Make an HTTPS GET through the proxy tunnel, returns { status, body } */
async function proxyGet(host, path = "/", { port = 443, timeout = 15_000 } = {}) {
  const { socket } = await connectTunnel(host, port);
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
    let raw = "";
    tlsSocket.setTimeout(timeout, () => { tlsSocket.destroy(); reject(new Error("TLS timeout")); });
    tlsSocket.on("error", reject);
    tlsSocket.on("secureConnect", () => {
      tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: vault-test/1.0\r\n\r\n`);
    });
    tlsSocket.on("data", d => raw += d.toString());
    tlsSocket.on("end", () => {
      const [header, ...bodyParts] = raw.split("\r\n\r\n");
      const statusLine = header.split("\r\n")[0];
      const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
      resolve({ status, body: bodyParts.join("\r\n\r\n") });
    });
  });
}

// We use dynamic import for tls since we need it after the CONNECT
import * as tls from "node:tls";

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testProxyReachability() {
  info(`Vault: ${VAULT_URL} (${PROXY_HOST}:${PROXY_PORT})`);
  try {
    // Simple healthz
    const protocol = PROXY_HTTPS ? https : http;
    await new Promise((resolve, reject) => {
      protocol.get(`${VAULT_URL}/healthz`, { rejectUnauthorized: false, timeout: 5000 }, res => {
        if (res.statusCode < 500) pass("vault /healthz reachable", `HTTP ${res.statusCode}`);
        else fail("vault /healthz", `HTTP ${res.statusCode} (vault may be down)`);
        resolve();
      }).on("error", e => { fail("vault unreachable", e.message); resolve(); });
    });
  } catch (e) { fail("vault reachability", e.message); }
}

async function testCACert() {
  // Try to fetch the CA cert so clients can trust the vault's MITM cert
  const protocol = PROXY_HTTPS ? https : http;
  for (const path of ["/ca.crt", "/ca.pem", "/ca", "/root.crt"]) {
    try {
      const data = await new Promise((resolve, reject) => {
        protocol.get(`${VAULT_URL}${path}`, { rejectUnauthorized: false, timeout: 5000 }, res => {
          if (res.statusCode !== 200) { resolve(null); return; }
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => resolve(d));
        }).on("error", () => resolve(null));
      });
      if (data?.includes("BEGIN CERTIFICATE")) {
        pass("vault CA cert", `${path} (${data.length}b)`);
        console.log("    CA cert preview:", data.slice(0, 80).trim(), "...");
        return data;
      }
    } catch {}
  }
  fail("vault CA cert", "not exposed at /ca.crt or /ca.pem — clients must trust vault CA manually");
  return null;
}

async function testCONNECT() {
  try {
    const { socket } = await connectTunnel("example.com", 443);
    socket.destroy();
    pass("CONNECT tunnel", "example.com:443 via proxy");
  } catch (e) { fail("CONNECT tunnel", e.message); }
}

async function testPyPI() {
  // pip/uv uses pypi.org — vault must forward it
  try {
    const { status, body } = await proxyGet("pypi.org", "/simple/requests/");
    if (status >= 200 && status < 400) pass("PyPI (pip/uv)", `pypi.org/simple/requests → HTTP ${status}`);
    else fail("PyPI", `HTTP ${status}`);
  } catch (e) { fail("PyPI", e.message); }
}

async function testGitHub() {
  // GitHub API — used by gh CLI and git operations
  try {
    const { status, body } = await proxyGet("api.github.com", "/", { timeout: 10_000 });
    if (status >= 200 && status < 400) pass("GitHub API", `api.github.com → HTTP ${status}`);
    else fail("GitHub API", `HTTP ${status}`);
  } catch (e) { fail("GitHub API", e.message); }
}

async function testNPM() {
  try {
    const { status } = await proxyGet("registry.npmjs.org", "/");
    if (status >= 200 && status < 400) pass("npm registry", `registry.npmjs.org → HTTP ${status}`);
    else fail("npm registry", `HTTP ${status}`);
  } catch (e) { fail("npm registry", e.message); }
}

async function testTokenInterception() {
  // Check /interceptions to confirm vault is intercepting & swapping tokens
  if (!VAULT_INSPECT_TOKEN) { info("VAULT_INSPECT_TOKEN not set — skipping interception check"); return; }
  const protocol = PROXY_HTTPS ? https : http;
  try {
    const data = await new Promise((resolve, reject) => {
      protocol.get(`${VAULT_URL}/interceptions`, {
        rejectUnauthorized: false, timeout: 5000,
        headers: { "X-Vault-Inspect-Token": VAULT_INSPECT_TOKEN },
      }, res => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => resolve([res.statusCode, d]));
      }).on("error", reject);
    });
    const [code, body] = data;
    if (code === 200) {
      const parsed = JSON.parse(body);
      pass("vault interceptions endpoint", `${parsed.length ?? "?"} intercepted requests`);
    } else {
      fail("vault interceptions", `HTTP ${code}`);
    }
  } catch (e) { fail("vault interceptions", e.message); }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log("\n=== Cloud Vault Proxy Test ===\n");
info("Instructions: set HTTPS_PROXY=<vault_url> and SSL_CERT_FILE=/path/to/vault-ca.crt in sandbox");
info("              for pip: UV_NATIVE_TLS=true or REQUESTS_CA_BUNDLE=/path/to/vault-ca.crt\n");

await testProxyReachability();
await testCACert();
await testCONNECT();
await testPyPI();
await testGitHub();
await testNPM();
await testTokenInterception();

const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${"─".repeat(40)}`);
console.log(`${passed}/${total} passed`);
if (passed < total) {
  console.log("\nFailed:");
  results.filter(r => !r.ok).forEach(r => console.log(`  • ${r.name}`));
  console.log("\nIf vault is down (all 502): redeploy the Railway service.");
  console.log("If CONNECT fails: Railway may not forward CONNECT — vault needs raw TCP exposure.");
  process.exit(1);
}
