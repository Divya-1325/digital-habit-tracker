const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("./server");

test("normalizes email addresses", () => {
  assert.equal(normalizeEmail("  USER@Example.COM "), "user@example.com");
});

test("normalizes usernames", () => {
  assert.equal(normalizeUsername("  HabitHero_7 "), "habithero_7");
});

test("validates email addresses", () => {
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("user.example.com"), false);
});

test("validates usernames", () => {
  assert.equal(isValidUsername("habit_hero"), true);
  assert.equal(isValidUsername("ab"), false);
  assert.equal(isValidUsername("bad name"), false);
});

test("validates HH:MM reminders", () => {
  assert.equal(isValidReminder("00:00"), true);
  assert.equal(isValidReminder("23:59"), true);
  assert.equal(isValidReminder("24:00"), false);
  assert.equal(isValidReminder("9:30"), false);
});

test("formats local date and time strings", () => {
  const date = new Date(2026, 4, 28, 9, 5);

  assert.equal(getLocalDateString(date), "2026-05-28");
  assert.equal(getCurrentTimeString(date), "09:05");
});

test("validates auth payloads", () => {
  assert.deepEqual(validateAuthPayload({ identifier: "USER@example.com", password: "secret123" }), {
    value: { identifier: "user@example.com", password: "secret123" }
  });
  assert.deepEqual(
    validateAuthPayload(
      { email: "USER@example.com", username: "HabitHero", password: "secret123" },
      { signup: true }
    ),
    {
      value: {
        email: "user@example.com",
        username: "habithero",
        password: "secret123"
      }
    }
  );
  assert.match(
    validateAuthPayload({ email: "user@example.com", username: "no", password: "secret123" }, {
      signup: true
    }).error,
    /username/i
  );
  assert.match(
    validateAuthPayload({ password: "secret123" }).error,
    /email or username/i
  );
  assert.match(
    validateAuthPayload({ email: "bad", username: "habit_hero", password: "secret123" }, {
      signup: true
    }).error,
    /valid email/i
  );
  assert.match(
    validateAuthPayload({ identifier: "habit_hero" }).error,
    /password/i
  );
  assert.match(
    validateAuthPayload(
      { email: "user@example.com", username: "habit_hero", password: "short" },
      { signup: true }
    ).error,
    /at least 8/i
  );
});

test("login payload can use username", () => {
  assert.deepEqual(validateAuthPayload({ username: "HabitHero", password: "secret123" }), {
    value: { identifier: "habithero", password: "secret123" }
  });
});

test("hashes and verifies passwords", () => {
  const storedHash = hashPassword("secret123");

  assert.equal(verifyPassword("secret123", storedHash), true);
  assert.equal(verifyPassword("wrong123", storedHash), false);
});

test("accepts a valid habit payload", () => {
  const result = validateHabitPayload({
    name: "Walk",
    reminder: "08:30",
    notes: "Park loop",
    isActive: true
  });

  assert.deepEqual(result, {
    value: {
      name: "Walk",
      reminder: "08:30",
      notes: "Park loop",
      isActive: true
    }
  });
});

test("accepts partial habit updates", () => {
  assert.deepEqual(validateHabitPayload({ reminder: "19:45" }, { partial: true }), {
    value: { reminder: "19:45" }
  });
});

test("rejects invalid habit payloads", () => {
  assert.match(validateHabitPayload({}).error, /habit name/i);
  assert.match(validateHabitPayload({ name: "Walk", reminder: "99:99" }).error, /HH:MM/i);
  assert.match(validateHabitPayload({}, { partial: true }).error, /No habit changes/i);
});
