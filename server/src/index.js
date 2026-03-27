import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");
const sessionsDir = path.join(dataDir, "sessions");
const clientDistDir = path.resolve(__dirname, "../../client/dist");

fs.mkdirSync(sessionsDir, { recursive: true });

const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const allowedOrigins = CLIENT_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-env";
const USER1_NAME = process.env.USER1_NAME || "saniya";
const USER1_PASSWORD = process.env.USER1_PASSWORD || "saniya1234";
const USER2_NAME = process.env.USER2_NAME || "sujal";
const USER2_PASSWORD = process.env.USER2_PASSWORD || "sujal1234";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "chat-uploads";
const SUPABASE_FILE_SIGNED_URL_TTL_SECONDS = Number(
  process.env.SUPABASE_FILE_SIGNED_URL_TTL_SECONDS || 60,
);
const DB_CONNECTION_TIMEOUT_MS = Number(process.env.DB_CONNECTION_TIMEOUT_MS || 60000);
const DB_INIT_MAX_ATTEMPTS = Number(process.env.DB_INIT_MAX_ATTEMPTS || 5);
const DB_INIT_RETRY_DELAY_MS = Number(process.env.DB_INIT_RETRY_DELAY_MS || 5000);

function getDatabaseTargetSummary(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const port = parsed.port || "5432";
    const databaseName = parsed.pathname.replace(/^\//, "") || "(unknown-db)";
    return `${parsed.hostname}:${port}/${databaseName}`;
  } catch {
    return "invalid connection string";
  }
}

function hasEnvValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function logEnvPresence() {
  const requiredForStartup = [
    ["SESSION_SECRET", SESSION_SECRET],
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
    ["SUPABASE_DB_URL", SUPABASE_DB_URL],
  ];

  const configuredWithDefaults = [
    ["NODE_ENV", NODE_ENV],
    ["CLIENT_ORIGIN", CLIENT_ORIGIN],
    ["SUPABASE_STORAGE_BUCKET", SUPABASE_STORAGE_BUCKET],
    ["SUPABASE_FILE_SIGNED_URL_TTL_SECONDS", String(SUPABASE_FILE_SIGNED_URL_TTL_SECONDS)],
    ["DB_CONNECTION_TIMEOUT_MS", String(DB_CONNECTION_TIMEOUT_MS)],
    ["DB_INIT_MAX_ATTEMPTS", String(DB_INIT_MAX_ATTEMPTS)],
    ["DB_INIT_RETRY_DELAY_MS", String(DB_INIT_RETRY_DELAY_MS)],
    ["USER1_NAME", USER1_NAME],
    ["USER1_PASSWORD", USER1_PASSWORD],
    ["USER2_NAME", USER2_NAME],
    ["USER2_PASSWORD", USER2_PASSWORD],
  ];

  const requiredMissing = requiredForStartup
    .filter(([, value]) => !hasEnvValue(value))
    .map(([name]) => name);
  const requiredPresent = requiredForStartup
    .filter(([, value]) => hasEnvValue(value))
    .map(([name]) => name);

  const optionalPresent = configuredWithDefaults
    .filter(([, value]) => hasEnvValue(value))
    .map(([name]) => name);

  console.log("[startup] Env check");
  console.log(
    `[startup] Required present (${requiredPresent.length}/${requiredForStartup.length}): ${requiredPresent.join(", ") || "none"}`,
  );
  if (requiredMissing.length > 0) {
    console.error(`[startup] Required missing: ${requiredMissing.join(", ")}`);
  }
  console.log(
    `[startup] Config/default present (${optionalPresent.length}/${configuredWithDefaults.length}): ${optionalPresent.join(", ") || "none"}`,
  );
}

logEnvPresence();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_DB_URL) {
  throw new Error(
    "Missing Supabase configuration. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DB_URL.",
  );
}

const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function seedUser(username, password) {
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `
      INSERT INTO chat_users (username, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (username) DO NOTHING
    `,
    [username.toLowerCase(), passwordHash],
  );
}

async function initializeDatabase() {
  const dbTarget = getDatabaseTargetSummary(SUPABASE_DB_URL);
  console.log(`[startup] DB target: ${dbTarget}`);

  for (let attempt = 1; attempt <= DB_INIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      console.log("[startup] DB connectivity check passed.");

      await seedUser(USER1_NAME, USER1_PASSWORD);
      await seedUser(USER2_NAME, USER2_PASSWORD);
      console.log("[startup] Seed users ensured.");
      return;
    } catch (error) {
      const isLastAttempt = attempt === DB_INIT_MAX_ATTEMPTS;
      console.error(
        `[startup] Database initialization attempt ${attempt}/${DB_INIT_MAX_ATTEMPTS} failed:`,
        error,
      );

      if (isLastAttempt) {
        console.error("[startup] Database initialization failed.");
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, DB_INIT_RETRY_DELAY_MS));
    }
  }
}

function mapMessageRow(row) {
  return {
    id: row.id,
    type: row.type,
    body: row.body,
    createdAt: new Date(row.created_at).getTime(),
    sender: {
      id: row.sender_id,
      username: row.sender_username || "unknown",
    },
    file: row.attachment_id
      ? {
          id: row.attachment_id,
          name: row.attachment_name,
          mimeType: row.attachment_mime_type,
          size: Number(row.attachment_size),
        }
      : null,
  };
}

async function getMessageById(messageId) {
  const { rows } = await pool.query(
    `
      SELECT
        m.id,
        m.type,
        m.body,
        m.created_at,
        u.id AS sender_id,
        u.username AS sender_username,
        f.id AS attachment_id,
        f.original_name AS attachment_name,
        f.mime_type AS attachment_mime_type,
        f.size AS attachment_size
      FROM chat_messages m
      JOIN chat_users u ON u.id = m.sender_id
      LEFT JOIN chat_files f ON f.id = m.file_id
      WHERE m.id = $1
      LIMIT 1
    `,
    [messageId],
  );

  if (!rows[0]) {
    return null;
  }

  return mapMessageRow(rows[0]);
}

await initializeDatabase();

const FileStore = FileStoreFactory(session);

const app = express();
const httpServer = createServer(app);

httpServer.on("error", (error) => {
  console.error("[startup] HTTP server failed to bind:", error);
  process.exit(1);
});

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

app.use(
  cors({
    origin: isProduction ? allowedOrigins : CLIENT_ORIGIN,
    credentials: true,
  }),
);

app.use(express.json());

const sessionMiddleware = session({
  store: new FileStore({
    path: sessionsDir,
    ttl: 24 * 60 * 60,
    retries: 0,
    logFn: () => {},
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
    maxAge: 1000 * 60 * 60 * 24,
  },
});

app.use(sessionMiddleware);

const loginRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in a few minutes." },
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const { rows } = await pool.query(
    "SELECT id, username, password_hash FROM chat_users WHERE username = lower($1) LIMIT 1",
    [String(username)],
  );
  const user = rows[0];

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  req.session.userId = user.id;
  req.session.username = user.username;

  try {
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  } catch {
    return res.status(500).json({ error: "Could not create session. Try again." });
  }

  return res.json({ user: { id: user.id, username: user.username } });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  return res.json({ user: { id: req.session.userId, username: req.session.username } });
});

app.get("/api/messages", requireAuth, async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const requestedOffset = Number(req.query.offset);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

  const [countResult, pageResult] = await Promise.all([
    pool.query("SELECT COUNT(*)::bigint AS total FROM chat_messages"),
    pool.query(
      `
        SELECT
          m.id,
          m.type,
          m.body,
          m.created_at,
          u.id AS sender_id,
          u.username AS sender_username,
          f.id AS attachment_id,
          f.original_name AS attachment_name,
          f.mime_type AS attachment_mime_type,
          f.size AS attachment_size
        FROM chat_messages m
        JOIN chat_users u ON u.id = m.sender_id
        LEFT JOIN chat_files f ON f.id = m.file_id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    ),
  ]);

  const total = Number(countResult.rows[0]?.total || 0);
  const messages = pageResult.rows.reverse().map(mapMessageRow);
  const nextOffset = offset + messages.length;
  const hasMore = nextOffset < total;

  return res.json({
    messages,
    pagination: {
      limit,
      offset,
      nextOffset,
      hasMore,
      total,
    },
  });
});

const allowedMimePrefixes = ["image/", "audio/", "video/"];
const allowedMimeSet = new Set(["application/pdf"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed =
      allowedMimePrefixes.some((prefix) => file.mimetype.startsWith(prefix)) ||
      allowedMimeSet.has(file.mimetype);
    if (!allowed) {
      return cb(new Error("Unsupported file type."));
    }
    return cb(null, true);
  },
});

app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const fileId = uuidv4();
  const messageId = uuidv4();
  const createdAt = new Date();
  const createdAtMs = createdAt.getTime();
  const extension = path.extname(req.file.originalname || "").replace(/[^a-zA-Z0-9.]/g, "");
  const storagePath = `uploads/${req.session.userId}/${createdAtMs}-${fileId}${extension}`;

  const uploadResult = await supabase.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, req.file.buffer, {
      cacheControl: "3600",
      upsert: false,
      contentType: req.file.mimetype,
    });

  if (uploadResult.error) {
    return res.status(500).json({ error: `Supabase upload failed: ${uploadResult.error.message}` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO chat_files (id, original_name, storage_path, mime_type, size, sender_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        fileId,
        req.file.originalname,
        storagePath,
        req.file.mimetype,
        req.file.size,
        req.session.userId,
        createdAt,
      ],
    );

    await client.query(
      `
        INSERT INTO chat_messages (id, sender_id, type, body, file_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [messageId, req.session.userId, "file", null, fileId, createdAt],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    await supabase.storage.from(SUPABASE_STORAGE_BUCKET).remove([storagePath]);
    throw error;
  } finally {
    client.release();
  }

  const payload = await getMessageById(messageId);
  if (!payload) {
    return res.status(500).json({ error: "Failed to load saved message." });
  }

  io.to("private-chat").emit("message:new", payload);
  return res.json({ message: payload });
});

app.get("/api/files/:id", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, original_name, storage_path, mime_type, size FROM chat_files WHERE id = $1 LIMIT 1",
    [req.params.id],
  );
  const file = rows[0];

  if (!file) {
    return res.status(404).json({ error: "File not found." });
  }

  const signedUrlResult = await supabase.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(file.storage_path, SUPABASE_FILE_SIGNED_URL_TTL_SECONDS);

  if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) {
    return res.status(500).json({ error: "Could not create signed download URL." });
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.redirect(302, signedUrlResult.data.signedUrl);
});

app.use((err, _req, res, _next) => {
  const message = err?.message || "Server error";
  if (message === "Unsupported file type.") {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
});

const clientDistExists = fs.existsSync(clientDistDir);
console.log(`[startup] client dist path: ${clientDistDir}`);
console.log(`[startup] client dist exists: ${clientDistExists}`);

if (clientDistExists) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
}

const io = new Server(httpServer, {
  cors: {
    origin: isProduction ? allowedOrigins : CLIENT_ORIGIN,
    credentials: true,
  },
});

const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.use((socket, next) => {
  const userId = socket.request.session?.userId;
  const username = socket.request.session?.username;
  if (!userId || !username) {
    return next(new Error("Unauthorized"));
  }

  socket.user = { id: userId, username };
  return next();
});

io.on("connection", (socket) => {
  socket.join("private-chat");

  socket.on("message:send", async (payload) => {
    const text = String(payload?.text || "").trim();
    if (!text) {
      return;
    }

    const createdAt = new Date();
    const messageId = uuidv4();

    await pool.query(
      `
        INSERT INTO chat_messages (id, sender_id, type, body, file_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [messageId, socket.user.id, "text", text, null, createdAt],
    );

    io.to("private-chat").emit("message:new", {
      id: messageId,
      type: "text",
      body: text,
      createdAt: createdAt.getTime(),
      sender: socket.user,
      file: null,
    });
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Seed users: ${USER1_NAME} and ${USER2_NAME}`);
});
