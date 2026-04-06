/**
 * Authentication helpers: hashing, sessions, middleware.
 */
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { Users, Sessions, Audit } = require("./db/ops-repo");

const COOKIE_NAME = "aqi_sid";
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 24;
const COST = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function expiryDate(hours) {
  const d = new Date(Date.now() + (hours || SESSION_HOURS) * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function createSession(userId, ip, userAgent) {
  const token = newToken();
  await Sessions.create({
    token, user_id: userId, expires_at: expiryDate(),
    ip, user_agent: (userAgent || "").slice(0, 500),
  });
  return token;
}

async function getSession(token) {
  if (!token) return null;
  return Sessions.find(token);
}

async function destroySession(token) {
  if (token) await Sessions.destroy(token);
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// ── Middleware ──────────────────────────────────────────────
async function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const sess = await getSession(token);
    if (sess) {
      req.user = { id: sess.user_id, email: sess.email, name: sess.name, role: sess.role };
      req.sessionToken = token;
    }
  } catch (e) {
    console.error("Session lookup error:", e.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts("html")) return res.redirect("/admin/login");
    return res.status(401).json({ error: "unauthenticated" });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/admin/login");
    if (!roles.includes(req.user.role)) {
      return res.status(403).send("Acesso negado");
    }
    next();
  };
}

async function setupNeeded() {
  return (await Users.count()) === 0;
}

async function createInitialSuperadmin({ email, password, name }) {
  const password_hash = await hashPassword(password);
  const id = await Users.create({ email, password_hash, name, role: "superadmin", created_by: null });
  return id;
}

async function logAction(req, action, entity_type, entity_id, details) {
  try {
    await Audit.log(
      req.user ? req.user.id : null,
      action, entity_type, entity_id, details,
      req.ip || (req.headers && req.headers["x-forwarded-for"]) || ""
    );
  } catch (e) {
    console.error("Audit log error:", e.message);
  }
}

module.exports = {
  COOKIE_NAME,
  hashPassword, verifyPassword,
  createSession, getSession, destroySession,
  setSessionCookie, clearSessionCookie,
  loadUser, requireAuth, requireRole,
  setupNeeded, createInitialSuperadmin,
  logAction,
};
