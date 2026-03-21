import path from "path";
import fs from "fs";
import fsp from "fs/promises";
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");
const uploadDir = path.join(dataDir, "uploads");
const sessionsDir = path.join(dataDir, "sessions");
const dbFile = path.join(dataDir, "store.json");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-env";
const USER1_NAME = process.env.USER1_NAME || "saniya";
const USER1_PASSWORD = process.env.USER1_PASSWORD || "saniya1234";
const USER2_NAME = process.env.USER2_NAME || "sujal";
const USER2_PASSWORD = process.env.USER2_PASSWORD || "sujal1234";

const FileStore = FileStoreFactory(session);

async function readStore() {
  try {
    const raw = await fsp.readFile(dbFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      users: [],
      files: [],
      messages: [],
      counters: {
        userId: 0,
      },
    };
  }
}

async function writeStore(store) {
  await fsp.writeFile(dbFile, JSON.stringify(store, null, 2), "utf8");
}

const store = await readStore();

async function seedUser(username, password) {
  const existing = store.users.find((item) => item.username === username);
  if (existing) {
    return;
  }

  store.counters.userId += 1;
  const passwordHash = await bcrypt.hash(password, 12);

  store.users.push({
    id: store.counters.userId,
    username,
    passwordHash,
    createdAt: Date.now(),
  });
}

await seedUser(USER1_NAME, USER1_PASSWORD);
await seedUser(USER2_NAME, USER2_PASSWORD);
await writeStore(store);

const app = express();
const httpServer = createServer(app);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

app.use(
  cors({
    origin: CLIENT_ORIGIN,
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
    secure: false,
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

function getUserById(userId) {
  return store.users.find((item) => item.id === userId);
}

app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = store.users.find((item) => item.username === username);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  return res.json({ user: { id: user.id, username: user.username } });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.post("/api/auth/logout-beacon", (req, res) => {
  if (!req.session) {
    return res.status(204).end();
  }

  return req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.status(204).end();
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.json({ user: { id: req.session.userId, username: req.session.username } });
});

function mapMessage(rawMessage) {
  const sender = getUserById(rawMessage.senderId);
  const rawFile = rawMessage.fileId
    ? store.files.find((item) => item.id === rawMessage.fileId)
    : null;

  return {
    id: rawMessage.id,
    type: rawMessage.type,
    body: rawMessage.body,
    createdAt: rawMessage.createdAt,
    sender: {
      id: sender?.id,
      username: sender?.username || "unknown",
    },
    file: rawFile
      ? {
          id: rawFile.id,
          name: rawFile.originalName,
          mimeType: rawFile.mimeType,
          size: rawFile.size,
        }
      : null,
  };
}

app.get("/api/messages", requireAuth, (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const requestedOffset = Number(req.query.offset);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

  const total = store.messages.length;
  const end = Math.max(total - offset, 0);
  const start = Math.max(end - limit, 0);

  const messages = store.messages.slice(start, end).map(mapMessage);
  const nextOffset = offset + messages.length;
  const hasMore = start > 0;

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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname);
    cb(null, `${uuidv4()}${extension}`);
  },
});

const upload = multer({
  storage,
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
  const createdAt = Date.now();

  store.files.push({
    id: fileId,
    originalName: req.file.originalname,
    storedName: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    senderId: req.session.userId,
    createdAt,
  });

  store.messages.push({
    id: messageId,
    senderId: req.session.userId,
    type: "file",
    body: null,
    fileId,
    createdAt,
  });

  await writeStore(store);

  const payload = mapMessage(store.messages[store.messages.length - 1]);
  io.to("private-chat").emit("message:new", payload);
  return res.json({ message: payload });
});

app.get("/api/files/:id", requireAuth, async (req, res) => {
  const file = store.files.find((item) => item.id === req.params.id);
  if (!file) {
    return res.status(404).json({ error: "File not found." });
  }

  const absolutePath = path.join(uploadDir, file.storedName);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: "Stored file is missing." });
  }

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable, no-transform");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.originalName)}"`);
  return res.sendFile(absolutePath);
});

app.use((err, _req, res, _next) => {
  const message = err?.message || "Server error";
  if (message === "Unsupported file type.") {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
});

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
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

    const createdAt = Date.now();
    const messageId = uuidv4();

    store.messages.push({
      id: messageId,
      senderId: socket.user.id,
      type: "text",
      body: text,
      fileId: null,
      createdAt,
    });

    await writeStore(store);

    io.to("private-chat").emit("message:new", mapMessage(store.messages[store.messages.length - 1]));
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Seed users: ${USER1_NAME}/${USER1_PASSWORD} and ${USER2_NAME}/${USER2_PASSWORD}`);
});
