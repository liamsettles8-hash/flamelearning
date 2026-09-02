import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dirOf = (specifier) => path.dirname(require.resolve(specifier));
const app = Fastify({ logger: true });

const DATA_DIR = process.env.FLAME_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "users.json");
const SESSION_DAYS = 30;
const COOKIE_NAME = "flame_session";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "935370065057-k58fma46d6veld0chs5qvqujkli4eqss.apps.googleusercontent.com";

await fs.mkdir(DATA_DIR, { recursive: true });
async function loadDb() {
  try { return JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
  catch { return { users: {}, sessions: {} }; }
}
let db = await loadDb();
let saveTimer = null;
async function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const tmp = DB_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, DB_FILE);
  }, 50);
}
function id() { return crypto.randomBytes(24).toString("hex"); }
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, record) {
  const actual = crypto.scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name || "", picture: user.picture || "" };
}
async function createSession(userId, reply) {
  const token = id() + id();
  db.sessions[token] = { userId, expires: Date.now() + SESSION_DAYS * 86400000 };
  await saveDb();
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: SESSION_DAYS * 86400
  });
}
async function getUser(req) {
  const token = req.cookies[COOKIE_NAME];
  const session = token && db.sessions[token];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete db.sessions[token]; await saveDb(); return null;
  }
  return db.users[session.userId] || null;
}
function validPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 200; }

app.register(fastifyCookie);

// Accept empty JSON bodies (for body-less POST actions such as logout).
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  if (body === "") return done(null, {});
  try { done(null, JSON.parse(body)); } catch (err) { done(err); }
});

app.addHook("onSend", async (req, reply) => {
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Embedder-Policy", "require-corp");
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  reply.header("X-Content-Type-Options", "nosniff");
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.endsWith(".mjs") || pathname.endsWith(".js")) reply.type("text/javascript; charset=utf-8");
  if (pathname.endsWith(".wasm")) reply.type("application/wasm");
});

app.get("/api/config", async () => ({ googleClientId: GOOGLE_CLIENT_ID }));

app.post("/api/auth/register", async (req, reply) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "Enter a valid email." });
  if (!validPassword(password)) return reply.code(400).send({ error: "Password must be at least 8 characters." });
  if (Object.values(db.users).some(u => u.email === email)) return reply.code(409).send({ error: "An account with that email already exists." });
  const uid = id();
  const pw = hashPassword(password);
  db.users[uid] = { id: uid, email, name, password: pw, bookmarks: [], tabs: [], settings: {} };
  await createSession(uid, reply);
  return { user: publicUser(db.users[uid]) };
});

app.post("/api/auth/login", async (req, reply) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const user = Object.values(db.users).find(u => u.email === email);
  if (!user?.password || !validPassword(password) || !verifyPassword(password, user.password))
    return reply.code(401).send({ error: "Invalid email or password." });
  await createSession(user.id, reply);
  return { user: publicUser(user) };
});

app.post("/api/auth/google", async (req, reply) => {
  if (!GOOGLE_CLIENT_ID) return reply.code(503).send({ error: "Google login is not configured. Set GOOGLE_CLIENT_ID." });
  const credential = req.body?.credential;
  if (!credential) return reply.code(400).send({ error: "Missing Google credential." });
  try {
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new Error("Invalid Google account.");
    const email = normalizeEmail(payload.email);
    let user = Object.values(db.users).find(u => u.googleSub === payload.sub || u.email === email);
    if (!user) {
      const uid = id();
      user = { id: uid, email, name: payload.name || "", picture: payload.picture || "", googleSub: payload.sub, bookmarks: [], tabs: [], settings: {} };
      db.users[uid] = user;
    } else {
      user.googleSub = payload.sub;
      user.name = payload.name || user.name;
      user.picture = payload.picture || user.picture;
    }
    await saveDb();
    await createSession(user.id, reply);
    return { user: publicUser(user) };
  } catch (e) {
    req.log.warn(e, "Google sign-in failed");
    return reply.code(401).send({ error: "Google sign-in failed." });
  }
});

app.post("/api/auth/logout", async (req, reply) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) { delete db.sessions[token]; await saveDb(); }
  reply.clearCookie(COOKIE_NAME, { path: "/" });
  return { ok: true };
});

app.get("/api/me", async (req, reply) => {
  const user = await getUser(req);
  return { user: user ? publicUser(user) : null };
});

app.get("/api/sync", async (req, reply) => {
  const user = await getUser(req);
  if (!user) return reply.code(401).send({ error: "Not signed in." });
  return { bookmarks: user.bookmarks || [], tabs: user.tabs || [], settings: user.settings || {} };
});

app.put("/api/sync", async (req, reply) => {
  const user = await getUser(req);
  if (!user) return reply.code(401).send({ error: "Not signed in." });
  const body = req.body || {};
  if (Array.isArray(body.bookmarks)) user.bookmarks = body.bookmarks.slice(0, 1000);
  if (Array.isArray(body.tabs)) user.tabs = body.tabs.slice(0, 100);
  if (body.settings && typeof body.settings === "object") user.settings = body.settings;
  await saveDb();
  return { ok: true };
});

await app.register(fastifyStatic, { root: path.join(__dirname, "..", "public") });
await app.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
await app.register(fastifyStatic, { root: dirOf("@mercuryworkshop/scramjet-controller"), prefix: "/controller/", decorateReply: false });
await app.register(fastifyStatic, { root: dirOf("@mercuryworkshop/scramjet-utils"), prefix: "/utils/", decorateReply: false });
await app.register(fastifyStatic, { root: dirOf("@mercuryworkshop/libcurl-transport"), prefix: "/libcurl/", decorateReply: false });
await app.register(fastifyStatic, { root: dirOf("@mercuryworkshop/epoxy-transport"), prefix: "/epoxy/", decorateReply: false });

const server = app.server;
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/wisp/") { req.url = pathname; wisp.routeRequest(req, socket, head); }
});

const port = Number(process.env.PORT || 8080);
await app.listen({ port, host: "0.0.0.0" });
console.log(`FlameBrowser running on http://localhost:${port}`);
