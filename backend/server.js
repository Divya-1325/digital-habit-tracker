const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

loadEnvFile();

const app = express();
app.use(cors());
app.use(express.json());

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 30;

let pool = null;
let emailTransporter = null;

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  try {
    const content = fs.readFileSync(envPath, "utf8");

    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) return;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not load backend/.env:", error.message);
    }
  }
}

function getMysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "digital_habit_tracker"
  };
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error("MYSQL_DATABASE may only contain letters, numbers, and underscores.");
  }

  return `\`${identifier}\``;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_PATTERN.test(normalizeEmail(email));
}

function isValidUsername(username) {
  return /^[a-z0-9_]{3,30}$/.test(normalizeUsername(username));
}

function isValidReminder(reminder) {
  return TIME_PATTERN.test(String(reminder || ""));
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentTimeString(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");

  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function validateAuthPayload(body, options = {}) {
  const email = normalizeEmail(body.email);
  const username = normalizeUsername(body.username);
  const identifier = normalizeUsername(body.identifier || body.email || body.username);
  const password = String(body.password || "");

  if (options.signup && !isValidUsername(username)) {
    return { error: "Username must be 3-30 characters using letters, numbers, or underscores." };
  }

  if (options.signup && !isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  if (!options.signup && !identifier) {
    return { error: "Email or username is required." };
  }

  if (!password) {
    return { error: "Password is required." };
  }

  if (options.signup && password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  if (options.signup) {
    return { value: { email, username, password } };
  }

  return { value: { identifier, password } };
}

function validateHabitPayload(body, options = {}) {
  const partial = Boolean(options.partial);
  const hasName = Object.prototype.hasOwnProperty.call(body, "name") ||
    Object.prototype.hasOwnProperty.call(body, "habit");
  const hasReminder = Object.prototype.hasOwnProperty.call(body, "reminder");
  const hasNotes = Object.prototype.hasOwnProperty.call(body, "notes");
  const hasActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const value = {};

  if (!partial || hasName) {
    const name = String(body.name || body.habit || "").trim();
    if (!name) return { error: "Habit name is required." };
    if (name.length > 100) return { error: "Habit name must be 100 characters or fewer." };
    value.name = name;
  }

  if (!partial || hasReminder) {
    const reminder = String(body.reminder || "").trim();
    if (!isValidReminder(reminder)) return { error: "Reminder must use HH:MM 24-hour time." };
    value.reminder = reminder;
  }

  if (hasNotes) {
    value.notes = String(body.notes || "").trim();
  }

  if (hasActive) {
    value.isActive = Boolean(body.isActive);
  }

  if (partial && Object.keys(value).length === 0) {
    return { error: "No habit changes were provided." };
  }

  return { value };
}

function parseId(id) {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return getLocalDateString(new Date(value));
}

function normalizeHabitHistory(history) {
  if (!history) return [];

  return String(history)
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [date, completedAt] = entry.split("|");
      return { date, completedAt: completedAt || null };
    });
}

function normalizeHabit(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    name: row.name,
    reminder: String(row.reminder).slice(0, 5),
    notes: row.notes || "",
    isActive: Boolean(row.isActive),
    log: row.log ? String(row.log).split(",").filter(Boolean) : [],
    history: normalizeHabitHistory(row.history),
    lastReminderSentDate: normalizeDate(row.lastReminderSentDate),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function getBearerToken(req) {
  const header = req.get("Authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ message: "Please log in." });
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.username
       FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > NOW()
       LIMIT 1`,
      [hashToken(token)]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    req.user = { id: Number(rows[0].id), email: rows[0].email, username: rows[0].username };
    return next();
  } catch (error) {
    return next(error);
  }
}

async function initializeDatabase() {
  const config = getMysqlConfig();
  const databaseName = quoteIdentifier(config.database);
  const bootstrapConnection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password
  });

  await bootstrapConnection.query(
    `CREATE DATABASE IF NOT EXISTS ${databaseName}
     CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci`
  );
  await bootstrapConnection.end();

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    namedPlaceholders: false,
    dateStrings: true
  });

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      username VARCHAR(30) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY users_email_unique (email),
      UNIQUE KEY users_username_unique (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureUsernameMigration();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY sessions_token_hash_unique (token_hash),
      KEY sessions_user_id_index (user_id),
      KEY sessions_expires_at_index (expires_at),
      CONSTRAINT sessions_user_id_fk FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS habits (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(100) NOT NULL,
      reminder_time CHAR(5) NOT NULL,
      notes TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_reminder_sent_date DATE NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY habits_user_id_index (user_id),
      KEY habits_reminder_time_index (reminder_time),
      CONSTRAINT habits_user_id_fk FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS habit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      habit_id BIGINT UNSIGNED NOT NULL,
      completed_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY habit_logs_habit_date_unique (habit_id, completed_date),
      KEY habit_logs_completed_date_index (completed_date),
      CONSTRAINT habit_logs_habit_id_fk FOREIGN KEY (habit_id)
        REFERENCES habits (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute("DELETE FROM sessions WHERE expires_at <= NOW()");
  console.log(`Connected to MySQL database '${config.database}'.`);
}

async function ensureUsernameMigration() {
  const config = getMysqlConfig();
  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'`,
    [config.database]
  );

  if (!columns.length) {
    await pool.execute("ALTER TABLE users ADD COLUMN username VARCHAR(30) NULL AFTER email");
  }

  await pool.execute(
    "UPDATE users SET username = CONCAT('user', id) WHERE username IS NULL OR username = ''"
  );
  await pool.execute("ALTER TABLE users MODIFY username VARCHAR(30) NOT NULL");

  const [indexes] = await pool.execute(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_username_unique'`,
    [config.database]
  );

  if (!indexes.length) {
    await pool.execute("ALTER TABLE users ADD UNIQUE KEY users_username_unique (username)");
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await pool.execute(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, hashToken(token), expiresAt]
  );

  return token;
}

async function createUser(email, username, password) {
  const [result] = await pool.execute(
    "INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)",
    [email, username, hashPassword(password)]
  );

  return { id: Number(result.insertId), email, username };
}

async function findUserByIdentifier(identifier) {
  const [rows] = await pool.execute(
    `SELECT id, email, username, password_hash AS passwordHash
     FROM users
     WHERE email = ? OR username = ?
     LIMIT 1`,
    [normalizeEmail(identifier), normalizeUsername(identifier)]
  );

  return rows[0] || null;
}

async function getHabitById(userId, id) {
  const habitId = parseId(id);
  if (!habitId) return null;

  const [rows] = await pool.execute(
    `SELECT h.id,
            h.name,
            h.reminder_time AS reminder,
            h.notes,
            h.is_active AS isActive,
            DATE_FORMAT(h.last_reminder_sent_date, '%Y-%m-%d') AS lastReminderSentDate,
            h.created_at AS createdAt,
            h.updated_at AS updatedAt,
            COALESCE(GROUP_CONCAT(DATE_FORMAT(l.completed_date, '%Y-%m-%d')
              ORDER BY l.completed_date SEPARATOR ','), '') AS log,
            COALESCE(GROUP_CONCAT(CONCAT(DATE_FORMAT(l.completed_date, '%Y-%m-%d'), '|',
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s'))
              ORDER BY l.completed_date SEPARATOR ','), '') AS history
     FROM habits h
     LEFT JOIN habit_logs l ON l.habit_id = h.id
     WHERE h.id = ? AND h.user_id = ?
     GROUP BY h.id, h.name, h.reminder_time, h.notes, h.is_active,
              h.last_reminder_sent_date, h.created_at, h.updated_at`,
    [habitId, userId]
  );

  return normalizeHabit(rows[0]);
}

async function listHabits(userId) {
  const [rows] = await pool.execute(
    `SELECT h.id,
            h.name,
            h.reminder_time AS reminder,
            h.notes,
            h.is_active AS isActive,
            DATE_FORMAT(h.last_reminder_sent_date, '%Y-%m-%d') AS lastReminderSentDate,
            h.created_at AS createdAt,
            h.updated_at AS updatedAt,
            COALESCE(GROUP_CONCAT(DATE_FORMAT(l.completed_date, '%Y-%m-%d')
              ORDER BY l.completed_date SEPARATOR ','), '') AS log,
            COALESCE(GROUP_CONCAT(CONCAT(DATE_FORMAT(l.completed_date, '%Y-%m-%d'), '|',
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s'))
              ORDER BY l.completed_date SEPARATOR ','), '') AS history
     FROM habits h
     LEFT JOIN habit_logs l ON l.habit_id = h.id
     WHERE h.user_id = ?
     GROUP BY h.id, h.name, h.reminder_time, h.notes, h.is_active,
              h.last_reminder_sent_date, h.created_at, h.updated_at
     ORDER BY h.created_at DESC`,
    [userId]
  );

  return rows.map(normalizeHabit);
}

async function createHabit(userId, data) {
  const [result] = await pool.execute(
    `INSERT INTO habits (user_id, name, reminder_time, notes, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, data.name, data.reminder, data.notes || null, data.isActive === false ? 0 : 1]
  );

  return getHabitById(userId, result.insertId);
}

async function updateHabit(userId, id, data) {
  const habitId = parseId(id);
  if (!habitId) return null;

  const fields = [];
  const values = [];

  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }

  if (data.reminder !== undefined) {
    fields.push("reminder_time = ?");
    values.push(data.reminder);
  }

  if (data.notes !== undefined) {
    fields.push("notes = ?");
    values.push(data.notes || null);
  }

  if (data.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(data.isActive ? 1 : 0);
  }

  if (!fields.length) return getHabitById(userId, habitId);

  values.push(habitId, userId);
  const [result] = await pool.execute(
    `UPDATE habits SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
    values
  );

  if (!result.affectedRows) return null;
  return getHabitById(userId, habitId);
}

async function setHabitCompletion(userId, id, completed, dateString = getLocalDateString()) {
  const habit = await getHabitById(userId, id);
  if (!habit) return null;

  if (completed) {
    await pool.execute(
      "INSERT IGNORE INTO habit_logs (habit_id, completed_date) VALUES (?, ?)",
      [parseId(id), dateString]
    );
  } else {
    await pool.execute(
      "DELETE FROM habit_logs WHERE habit_id = ? AND completed_date = ?",
      [parseId(id), dateString]
    );
  }

  return getHabitById(userId, id);
}

async function toggleHabitDate(userId, id, dateString = getLocalDateString()) {
  const habitId = parseId(id);
  if (!habitId) return null;

  const habit = await getHabitById(userId, habitId);
  if (!habit) return null;

  const isCompleted = habit.log.includes(dateString);
  return setHabitCompletion(userId, habitId, !isCompleted, dateString);
}

async function deleteHabit(userId, id) {
  const habitId = parseId(id);
  if (!habitId) return null;

  const habit = await getHabitById(userId, habitId);
  if (!habit) return null;

  await pool.execute("DELETE FROM habits WHERE id = ? AND user_id = ?", [habitId, userId]);
  return habit;
}

async function listDueHabits(currentTime, today) {
  const [rows] = await pool.execute(
    `SELECT h.id,
            h.name,
            h.reminder_time AS reminder,
            u.email,
            DATE_FORMAT(h.last_reminder_sent_date, '%Y-%m-%d') AS lastReminderSentDate
     FROM habits h
     INNER JOIN users u ON u.id = h.user_id
     WHERE h.is_active = 1
       AND h.reminder_time = ?
       AND (h.last_reminder_sent_date IS NULL OR h.last_reminder_sent_date <> ?)`,
    [currentTime, today]
  );

  return rows;
}

async function markReminderSent(id, dateString) {
  await pool.execute("UPDATE habits SET last_reminder_sent_date = ? WHERE id = ?", [
    dateString,
    parseId(id)
  ]);
}

function createEmailTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.log("Email reminders disabled: set EMAIL_USER and EMAIL_PASS to enable them.");
    return null;
  }

  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "gmail",
    auth: { user, pass }
  });
}

async function sendEmail(to, habitName) {
  if (!emailTransporter) return false;

  await emailTransporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    subject: "Habit Reminder",
    text: `Time to do your habit: ${habitName}`
  });

  return true;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    storage: "mysql",
    emailReminders: Boolean(emailTransporter)
  });
});

app.post(
  "/auth/signup",
  asyncHandler(async (req, res) => {
    const result = validateAuthPayload(req.body, { signup: true });
    if (result.error) return res.status(400).json({ message: result.error });

    try {
      const user = await createUser(
        result.value.email,
        result.value.username,
        result.value.password
      );
      const token = await createSession(user.id);
      return res.status(201).json({
        message: "Account created",
        token,
        user: { id: String(user.id), email: user.email, username: user.username }
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          message: "An account already exists for this email or username."
        });
      }

      throw error;
    }
  })
);

app.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const result = validateAuthPayload(req.body);
    if (result.error) return res.status(400).json({ message: result.error });

    const user = await findUserByIdentifier(result.value.identifier);
    if (!user || !verifyPassword(result.value.password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email/username or password." });
    }

    const token = await createSession(user.id);
    return res.json({
      message: "Logged in",
      token,
      user: { id: String(user.id), email: user.email, username: user.username }
    });
  })
);

app.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    const token = getBearerToken(req);
    if (token) {
      await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    }

    return res.json({ message: "Logged out" });
  })
);

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({
    user: {
      id: String(req.user.id),
      email: req.user.email,
      username: req.user.username
    }
  });
});

app.get(
  "/habits",
  requireAuth,
  asyncHandler(async (req, res) => {
    const habits = await listHabits(req.user.id);
    return res.json(habits);
  })
);

app.post(
  "/habits",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = validateHabitPayload(req.body);
    if (result.error) return res.status(400).json({ message: result.error });

    const habit = await createHabit(req.user.id, result.value);
    return res.status(201).json({ message: "Habit added", habit });
  })
);

app.put(
  "/habits/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = validateHabitPayload(req.body, { partial: true });
    if (result.error) return res.status(400).json({ message: result.error });

    const habit = await updateHabit(req.user.id, req.params.id, result.value);
    if (!habit) return res.status(404).json({ message: "Habit not found." });

    return res.json({ message: "Habit updated", habit });
  })
);

app.patch(
  "/habits/:id/toggle-today",
  requireAuth,
  asyncHandler(async (req, res) => {
    const habit = await toggleHabitDate(req.user.id, req.params.id);
    if (!habit) return res.status(404).json({ message: "Habit not found." });

    return res.json({ message: "Habit updated", habit });
  })
);

app.put(
  "/habits/:id/completion",
  requireAuth,
  asyncHandler(async (req, res) => {
    const completed = Boolean(req.body.completed);
    const date = req.body.date ? String(req.body.date) : getLocalDateString();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "Date must use YYYY-MM-DD format." });
    }

    const habit = await setHabitCompletion(req.user.id, req.params.id, completed, date);
    if (!habit) return res.status(404).json({ message: "Habit not found." });

    return res.json({ message: "Habit updated", habit });
  })
);

app.delete(
  "/habits/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const habit = await deleteHabit(req.user.id, req.params.id);
    if (!habit) return res.status(404).json({ message: "Habit not found." });

    return res.json({ message: "Habit deleted", habit });
  })
);

app.use(express.static(path.join(__dirname, "../frontend")));
app.use((req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

app.use((error, req, res, next) => {
  console.error(error);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

async function checkReminderQueue() {
  const now = new Date();
  const currentTime = getCurrentTimeString(now);
  const today = getLocalDateString(now);
  const habits = await listDueHabits(currentTime, today);

  await Promise.all(
    habits.map(async (habit) => {
      try {
        const sent = await sendEmail(habit.email, habit.name);
        if (sent) {
          await markReminderSent(habit.id, today);
        }
      } catch (error) {
        console.error(`Email reminder failed for ${habit.email}:`, error.message);
      }
    })
  );
}

async function startServer() {
  await initializeDatabase();
  emailTransporter = createEmailTransporter();

  cron.schedule("* * * * *", () => {
    checkReminderQueue().catch((error) => {
      console.error("Reminder check failed:", error.message);
    });
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Server failed to start:", error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  getCurrentTimeString,
  getLocalDateString,
  hashPassword,
  isValidEmail,
  isValidReminder,
  isValidUsername,
  normalizeEmail,
  normalizeUsername,
  validateAuthPayload,
  validateHabitPayload,
  verifyPassword
};
