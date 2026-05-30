const API_URL = "";

const BADGES = [
  { id: "BDG-00", name: "Clown", days: 0, image: "assets/badges/clown.svg" },
  { id: "BDG-01", name: "Noob", days: 1, image: "assets/badges/noob.svg" },
  { id: "BDG-03", name: "Novice", days: 3, image: "assets/badges/novice.svg" },
  { id: "BDG-07", name: "Average", days: 7, image: "assets/badges/average.svg" },
  { id: "BDG-15", name: "Advanced", days: 15, image: "assets/badges/advanced.svg" },
  { id: "BDG-30", name: "Sigma", days: 30, image: "assets/badges/sigma.svg" },
  { id: "BDG-45", name: "Chad", days: 45, image: "assets/badges/chad.svg" },
  { id: "BDG-60", name: "Absolute Chad", days: 60, image: "assets/badges/absolute-chad.svg" },
  { id: "BDG-120", name: "Giga Chad", days: 120, image: "assets/badges/giga-chad.svg" },
  {
    id: "BDG-365",
    name: "Absolute Giga Chad",
    days: 365,
    image: "assets/badges/absolute-giga-chad.svg"
  }
];

const REMINDER_CHECK_INTERVAL_MS = 10000;
const REMINDER_GRACE_MINUTES = 2;

let habitsCache = [];
let editingHabitId = null;
let lastNotificationKeys = new Set();
let notificationServiceWorker = null;
let reminderAudioContext = null;
let selectedDate = getLocalDateString();

function getToken() {
  return localStorage.getItem("authToken");
}

function setSession(token, user) {
  localStorage.setItem("authToken", token);
  localStorage.setItem("userEmail", user.email);
  localStorage.setItem("username", user.username);
}

function clearSession() {
  localStorage.removeItem("authToken");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("username");
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDateString(dateString) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ""));
}

function parseLocalDate(dateString) {
  if (!isValidDateString(dateString)) return new Date();

  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDisplayDate(dateString, options = {}) {
  const date = parseLocalDate(dateString);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "Not available";

  const normalized = String(value).replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function getDateRangeEnding(endDateString, days) {
  const endDate = parseLocalDate(endDateString);

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(endDate);
    date.setDate(endDate.getDate() - (days - 1 - index));
    return getLocalDateString(date);
  });
}

function updateDateControls() {
  const input = document.getElementById("trackingDate");
  const label = document.getElementById("selectedDateLabel");
  const todayButton = document.getElementById("todayDateBtn");
  const isToday = selectedDate === getLocalDateString();

  if (input) input.value = selectedDate;
  if (label) {
    label.textContent = isToday
      ? `Today, ${formatDisplayDate(selectedDate)}`
      : formatDisplayDate(selectedDate);
  }
  if (todayButton) todayButton.disabled = isToday;
}

function setSelectedDate(dateString) {
  selectedDate = isValidDateString(dateString) ? dateString : getLocalDateString();
  updateDateControls();
  renderDashboard();
}

function shiftSelectedDate(dayOffset) {
  const date = parseLocalDate(selectedDate);
  date.setDate(date.getDate() + dayOffset);
  setSelectedDate(getLocalDateString(date));
}

function getCurrentTimeString(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getCurrentSecondString(date = new Date()) {
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${getCurrentTimeString(date)}:${seconds}`;
}

function timeToMinutes(time) {
  const [hours, minutes] = String(time || "").split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return hours * 60 + minutes;
}

function setStatus(message, type = "info", targetId = "statusMessage") {
  const status = document.getElementById(targetId);
  if (!status) {
    if (type === "error") alert(message);
    return;
  }

  status.textContent = message;
  status.className = `status ${type}`;

  if (message) {
    window.clearTimeout(setStatus.timeoutId);
    setStatus.timeoutId = window.setTimeout(() => {
      status.textContent = "";
      status.className = "status";
    }, 4000);
  }
}

async function requestJson(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${url}`, {
    ...options,
    headers
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Request failed. Please try again.");
    error.status = response.status;
    throw error;
  }

  return data;
}

function switchAuthMode(mode) {
  const isLogin = mode === "login";
  document.getElementById("loginForm").classList.toggle("hidden", !isLogin);
  document.getElementById("signupForm").classList.toggle("hidden", isLogin);
  document.getElementById("loginTab").classList.toggle("active", isLogin);
  document.getElementById("signupTab").classList.toggle("active", !isLogin);
  setStatus("", "info", "authStatus");
}

async function handleLogin(event) {
  event.preventDefault();

  const identifier = document.getElementById("loginIdentifier").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    const result = await requestJson("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password })
    });

    setSession(result.token, result.user);
    window.location.href = "dashboard.html";
  } catch (error) {
    setStatus(error.message, "error", "authStatus");
  }
}

async function handleSignup(event) {
  event.preventDefault();

  const username = document.getElementById("signupUsername").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  const confirmPassword = document.getElementById("signupConfirmPassword").value;

  if (password !== confirmPassword) {
    setStatus("Passwords do not match.", "error", "authStatus");
    return;
  }

  try {
    const result = await requestJson("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, email, password })
    });

    setSession(result.token, result.user);
    window.location.href = "dashboard.html";
  } catch (error) {
    setStatus(error.message, "error", "authStatus");
  }
}

async function logout() {
  try {
    await requestJson("/auth/logout", { method: "POST", body: JSON.stringify({}) });
  } catch {
    // Local session cleanup still matters if the server is unavailable.
  }

  clearSession();
  window.location.href = "index.html";
}

async function verifySession() {
  if (!getToken()) {
    window.location.href = "index.html";
    return null;
  }

  try {
    const result = await requestJson("/auth/me");
    localStorage.setItem("userEmail", result.user.email);
    localStorage.setItem("username", result.user.username);
    return result.user;
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      window.location.href = "index.html";
      return null;
    }

    throw error;
  }
}

async function loadHabits() {
  try {
    habitsCache = await requestJson("/habits");
    renderDashboard();
    checkBrowserReminders().catch(() => undefined);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveHabit(event) {
  event.preventDefault();

  const payload = {
    name: document.getElementById("habitInput").value.trim(),
    reminder: document.getElementById("habitTime").value,
    notes: document.getElementById("habitNotes").value.trim(),
    isActive: document.getElementById("habitActive").checked
  };

  if (!payload.name) return setStatus("Habit name is required.", "error");
  if (!payload.reminder) return setStatus("Reminder time is required.", "error");

  try {
    const url = editingHabitId ? `/habits/${editingHabitId}` : "/habits";
    const method = editingHabitId ? "PUT" : "POST";
    const wasEditing = Boolean(editingHabitId);

    await requestJson(url, {
      method,
      body: JSON.stringify(payload)
    });

    resetHabitForm();
    setStatus(wasEditing ? "Habit updated." : "Habit saved.", "success");
    await loadHabits();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function editHabit(habit) {
  editingHabitId = habit.id;
  document.getElementById("habitFormTitle").textContent = "Edit habit";
  document.getElementById("saveHabitBtn").textContent = "Update habit";
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  document.getElementById("habitInput").value = habit.name;
  document.getElementById("habitTime").value = habit.reminder;
  document.getElementById("habitNotes").value = habit.notes || "";
  document.getElementById("habitActive").checked = habit.isActive;
  document.getElementById("habitInput").focus();
}

function resetHabitForm() {
  editingHabitId = null;
  document.getElementById("habitForm").reset();
  document.getElementById("habitTime").value = "08:00";
  document.getElementById("habitActive").checked = true;
  document.getElementById("habitFormTitle").textContent = "Add habit";
  document.getElementById("saveHabitBtn").textContent = "Save habit";
  document.getElementById("cancelEditBtn").classList.add("hidden");
}

async function setCompletion(habitId, completed) {
  try {
    const result = await requestJson(`/habits/${habitId}/completion`, {
      method: "PUT",
      body: JSON.stringify({ completed, date: selectedDate })
    });

    replaceHabit(result.habit);
    renderDashboard();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function toggleActive(habit) {
  try {
    const result = await requestJson(`/habits/${habit.id}`, {
      method: "PUT",
      body: JSON.stringify({ isActive: !habit.isActive })
    });

    replaceHabit(result.habit);
    renderDashboard();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function removeHabit(habitId) {
  const confirmed = window.confirm("Delete this habit?");
  if (!confirmed) return;

  try {
    await requestJson(`/habits/${habitId}`, { method: "DELETE" });
    habitsCache = habitsCache.filter((habit) => habit.id !== habitId);
    renderDashboard();
    setStatus("Habit deleted.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function replaceHabit(updatedHabit) {
  const index = habitsCache.findIndex((habit) => habit.id === updatedHabit.id);
  if (index === -1) {
    habitsCache.unshift(updatedHabit);
    return;
  }

  habitsCache[index] = updatedHabit;
}

function renderDashboard() {
  updateDateControls();
  renderHabitList(habitsCache);
  renderStats(habitsCache);
  renderBadgeSidebar(habitsCache);
  renderChart(habitsCache);
}

function renderHabitList(habits) {
  const list = document.getElementById("habitList");
  if (!list) return;

  list.innerHTML = "";

  if (!habits.length) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "empty-state";
    emptyItem.textContent = "No habits yet.";
    list.appendChild(emptyItem);
    return;
  }

  habits.forEach((habit) => {
    const isCompleted = isHabitCompletedOn(habit, selectedDate);
    const streakOnDate = calculateStreak(habit, selectedDate);
    const li = document.createElement("li");
    li.className = `habit-card${isCompleted ? " completed" : ""}${habit.isActive ? "" : " paused"}`;

    const content = document.createElement("div");
    content.className = "habit-content";

    const titleRow = document.createElement("div");
    titleRow.className = "habit-title-row";

    const title = document.createElement("h3");
    title.textContent = habit.name;

    const badge = document.createElement("span");
    badge.className = habit.isActive ? "badge active" : "badge muted";
    badge.textContent = habit.isActive ? "Active" : "Paused";

    const dateBadge = document.createElement("span");
    dateBadge.className = isCompleted ? "badge done-state" : "badge open-state";
    dateBadge.textContent = isCompleted ? "Done on date" : "Open on date";

    titleRow.appendChild(title);
    titleRow.appendChild(badge);
    titleRow.appendChild(dateBadge);

    const meta = document.createElement("p");
    meta.className = "habit-meta";
    meta.textContent = `Reminder ${habit.reminder} - Created ${formatDateTime(habit.createdAt)} - Streak on date ${streakOnDate}`;

    const notes = document.createElement("p");
    notes.className = "habit-notes";
    notes.textContent = habit.notes || "No notes";

    const completionRecord = getCompletionRecord(habit, selectedDate);
    const completionMeta = document.createElement("p");
    completionMeta.className = "habit-completion-meta";
    completionMeta.textContent = completionRecord
      ? `Marked done ${formatDateTime(completionRecord.completedAt)}`
      : `No completion stored for ${formatDisplayDate(selectedDate, {
          weekday: undefined,
          month: "short",
          day: "numeric",
          year: "numeric"
        })}`;

    const history = renderHistoryStrip(habit);

    content.appendChild(titleRow);
    content.appendChild(meta);
    content.appendChild(notes);
    content.appendChild(completionMeta);
    content.appendChild(history);

    const actions = document.createElement("div");
    actions.className = "habit-actions";

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = isCompleted ? "completeBtn selected" : "completeBtn";
    doneBtn.textContent = isCompleted ? "Done" : "Mark done";
    doneBtn.disabled = isCompleted;
    doneBtn.addEventListener("click", () => setCompletion(habit.id, true));

    const notDoneBtn = document.createElement("button");
    notDoneBtn.type = "button";
    notDoneBtn.className = "neutralBtn";
    notDoneBtn.textContent = "Not done";
    notDoneBtn.disabled = !isCompleted;
    notDoneBtn.addEventListener("click", () => setCompletion(habit.id, false));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => editHabit(habit));

    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "ghost";
    pauseBtn.textContent = habit.isActive ? "Pause" : "Resume";
    pauseBtn.addEventListener("click", () => toggleActive(habit));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "deleteBtn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => removeHabit(habit.id));

    actions.appendChild(doneBtn);
    actions.appendChild(notDoneBtn);
    actions.appendChild(editBtn);
    actions.appendChild(pauseBtn);
    actions.appendChild(deleteBtn);

    li.appendChild(content);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function renderStats(habits) {
  const total = habits.length;
  const doneToday = habits.filter((habit) => isHabitCompletedOn(habit, selectedDate)).length;
  const active = habits.filter((habit) => habit.isActive).length;
  const best = getBestStreak(habits, selectedDate);
  const isToday = selectedDate === getLocalDateString();

  document.getElementById("totalHabits").textContent = total;
  document.getElementById("doneToday").textContent = doneToday;
  document.getElementById("activeReminders").textContent = active;
  document.getElementById("bestStreak").textContent = best;
  document.getElementById("doneDateLabel").textContent = isToday ? "Done today" : "Done on date";
  document.getElementById("bestStreakLabel").textContent = isToday
    ? "Best streak"
    : "Best streak on date";
}

function renderBadgeSidebar(habits) {
  const badgeList = document.getElementById("badgeList");
  if (!badgeList) return;

  const bestStreak = getBestStreak(habits, getLocalDateString());
  const currentBadge = getBadgeForStreak(bestStreak);
  const unlockedCount = BADGES.filter((badge) => bestStreak >= badge.days).length;

  document.getElementById("currentBadgeName").textContent = currentBadge.name;
  document.getElementById("currentBadgeRequirement").textContent = `${currentBadge.days}+ days`;
  document.getElementById("currentBadgeId").textContent = currentBadge.id;
  document.getElementById("badgeProgressText").textContent = `${unlockedCount}/${BADGES.length}`;

  const accountBadge = document.getElementById("accountBadge");
  const accountBadgeImage = document.getElementById("accountBadgeImage");
  accountBadgeImage.src = currentBadge.image;
  accountBadgeImage.alt = `${currentBadge.name} badge`;
  document.getElementById("currentBadgeLabel").textContent = `${currentBadge.id} - ${currentBadge.name}`;
  accountBadge.dataset.badge = currentBadge.name;

  badgeList.innerHTML = "";

  BADGES.forEach((badge) => {
    const unlocked = bestStreak >= badge.days;
    const remaining = Math.max(badge.days - bestStreak, 0);
    const row = document.createElement("div");
    row.className = `badge-row${unlocked ? " unlocked" : " locked"}`;

    const icon = document.createElement("img");
    icon.className = "badge-icon";
    icon.src = badge.image;
    icon.alt = `${badge.name} badge`;

    const copy = document.createElement("div");
    copy.className = "badge-copy";

    const name = document.createElement("strong");
    name.textContent = badge.name;

    const requirement = document.createElement("span");
    requirement.textContent = unlocked
      ? `${badge.days}+ days unlocked`
      : `${badge.days}+ days, ${remaining} more`;

    const id = document.createElement("small");
    id.textContent = badge.id;

    copy.appendChild(name);
    copy.appendChild(requirement);
    copy.appendChild(id);
    row.appendChild(icon);
    row.appendChild(copy);
    badgeList.appendChild(row);
  });
}

function renderChart(habits) {
  const chartCanvas = document.getElementById("weeklyChart");
  if (!chartCanvas) return;

  const labels = getDateRangeEnding(selectedDate, 7);

  const datasets = habits.map((habit) => ({
    label: habit.name,
    data: labels.map((date) => (isHabitCompletedOn(habit, date) ? 1 : 0)),
    backgroundColor: getColorForHabit(habit.id || habit.name),
    borderRadius: 4
  }));

  if (window.chart) window.chart.destroy();

  window.chart = new Chart(chartCanvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          max: 1,
          ticks: { stepSize: 1 }
        }
      }
    }
  });
}

function isHabitCompletedOn(habit, dateString) {
  return (habit.log || []).includes(dateString);
}

function getCompletionRecord(habit, dateString) {
  return (habit.history || []).find((record) => record.date === dateString) || null;
}

function renderHistoryStrip(habit) {
  const history = document.createElement("div");
  history.className = "history-strip";
  history.setAttribute("aria-label", `Completion history ending ${formatDisplayDate(selectedDate)}`);

  getDateRangeEnding(selectedDate, 14).forEach((dateString) => {
    const isCompleted = isHabitCompletedOn(habit, dateString);
    const isSelected = dateString === selectedDate;
    const day = document.createElement("span");
    day.className = `history-day${isCompleted ? " done" : ""}${isSelected ? " selected" : ""}`;
    day.textContent = String(parseLocalDate(dateString).getDate());
    day.title = `${formatDisplayDate(dateString)} - ${isCompleted ? "done" : "not done"}`;
    history.appendChild(day);
  });

  return history;
}

function calculateStreak(habit, endDateString = getLocalDateString()) {
  const completedDates = new Set(habit.log || []);
  const cursor = parseLocalDate(endDateString);
  let streak = 0;

  while (completedDates.has(getLocalDateString(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

function getBestStreak(habits, endDateString = getLocalDateString()) {
  return Math.max(...habits.map((habit) => calculateStreak(habit, endDateString)), 0);
}

function getBadgeForStreak(streak) {
  return BADGES.reduce((current, badge) => {
    return streak >= badge.days ? badge : current;
  }, BADGES[0]);
}

function openBadgeSidebar() {
  document.body.classList.add("sidebar-open");
  const menuButton = document.getElementById("badgeMenuBtn");
  if (menuButton) menuButton.setAttribute("aria-expanded", "true");
}

function closeBadgeSidebar() {
  document.body.classList.remove("sidebar-open");
  const menuButton = document.getElementById("badgeMenuBtn");
  if (menuButton) menuButton.setAttribute("aria-expanded", "false");
}

function setNotificationStatus(message, type = "info") {
  const status = document.getElementById("notificationStatus");
  if (!status) return;

  status.textContent = message;
  status.className = `notification-state ${type}`;
}

async function registerNotificationServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;

  try {
    notificationServiceWorker = await navigator.serviceWorker.register("/sw.js", {
      scope: "/"
    });
    await navigator.serviceWorker.ready;
    return notificationServiceWorker;
  } catch (error) {
    console.warn("Service worker registration failed:", error);
    return null;
  }
}

function updateNotificationControls() {
  const status = document.getElementById("notificationStatus");
  const enableButton = document.getElementById("enableNotificationsBtn");
  const testButton = document.getElementById("testNotificationBtn");
  if (!status || !enableButton || !testButton) return;

  if (!("Notification" in window)) {
    setNotificationStatus("Not supported in this browser.", "error");
    enableButton.disabled = true;
    testButton.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    setNotificationStatus(
      "Enabled. System popups use the service worker when available.",
      "success"
    );
    enableButton.disabled = true;
    testButton.disabled = false;
    return;
  }

  if (Notification.permission === "denied") {
    setNotificationStatus("Blocked in browser settings.", "error");
    enableButton.disabled = true;
    testButton.disabled = true;
    return;
  }

  setNotificationStatus("Not enabled", "info");
  enableButton.disabled = false;
  testButton.disabled = true;
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    if ("Notification" in window && Notification.permission === "granted") {
      await registerNotificationServiceWorker();
    }
    updateNotificationControls();
    return;
  }

  unlockReminderSound();

  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    await registerNotificationServiceWorker();
  }
  updateNotificationControls();

  if (permission === "granted") {
    setNotificationStatus("Enabled. Click Test to verify the popup.", "success");
    await checkBrowserReminders();
  } else if (permission === "denied") {
    setNotificationStatus("Blocked in browser settings.", "error");
  }
}

function showInAppNotification(title, body, type = "info") {
  const stack = document.getElementById("inAppNotificationStack");
  if (!stack) return;

  const item = document.createElement("div");
  item.className = `in-app-notification ${type}`;

  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => item.remove());

  content.appendChild(heading);
  content.appendChild(text);
  item.appendChild(content);
  item.appendChild(closeButton);
  stack.appendChild(item);

  window.setTimeout(() => item.remove(), 12000);
}

function unlockReminderSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    reminderAudioContext = reminderAudioContext || new AudioContext();
    if (reminderAudioContext.state === "suspended") {
      reminderAudioContext.resume();
    }
  } catch {
    // Sound is only a bonus fallback.
  }
}

function playReminderSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    reminderAudioContext = reminderAudioContext || new AudioContext();

    const oscillator = reminderAudioContext.createOscillator();
    const gain = reminderAudioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, reminderAudioContext.currentTime);
    gain.gain.setValueAtTime(0.0001, reminderAudioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, reminderAudioContext.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, reminderAudioContext.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(reminderAudioContext.destination);
    oscillator.start();
    oscillator.stop(reminderAudioContext.currentTime + 0.36);
  } catch {
    // Ignore audio failures.
  }
}

async function notifyUser(title, options = {}, fallbackType = "info") {
  const body = options.body || "";
  showInAppNotification(title, body, fallbackType);
  playReminderSound();

  if (!("Notification" in window) || Notification.permission !== "granted") {
    updateNotificationControls();
    return false;
  }

  const notificationOptions = {
    body,
    icon: options.icon || "/assets/badges/advanced.svg",
    badge: options.badge || "/assets/badges/clown.svg",
    tag: options.tag || `habit-tracker-${Date.now()}`,
    renotify: options.renotify !== false,
    requireInteraction: Boolean(options.requireInteraction),
    data: {
      url: "/dashboard.html",
      ...(options.data || {})
    }
  };

  try {
    const registration =
      notificationServiceWorker ||
      (await registerNotificationServiceWorker()) ||
      (await navigator.serviceWorker?.ready);

    if (registration?.showNotification) {
      await registration.showNotification(title, notificationOptions);
      return true;
    }
  } catch (error) {
    console.warn("Service worker notification failed:", error);
  }

  try {
    new Notification(title, notificationOptions);
    return true;
  } catch (error) {
    console.warn("Page notification failed:", error);
    return false;
  }
}

async function sendTestNotification() {
  unlockReminderSound();
  const sent = await notifyUser(
    "Habit Tracker",
    {
      body: "Notifications are working. This is the new service-worker test.",
      tag: "habit-tracker-test",
      requireInteraction: true
    },
    "success"
  );
  setNotificationStatus(
    sent ? "Test notification sent." : "Test shown inside the app; system popup was blocked.",
    sent ? "success" : "error"
  );
  window.setTimeout(updateNotificationControls, 2500);
}

function setReminderCheckStatus(message, type = "info") {
  const status = document.getElementById("reminderCheckStatus");
  if (!status) return;

  status.textContent = message;
  status.className = `reminder-check-state ${type}`;
}

function getDueHabits(now = new Date()) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return habitsCache.filter((habit) => {
    const reminderMinutes = timeToMinutes(habit.reminder);
    if (!habit.isActive || reminderMinutes === null) return false;

    const minutesLate = currentMinutes - reminderMinutes;
    return minutesLate >= 0 && minutesLate <= REMINDER_GRACE_MINUTES;
  });
}

function getNextReminderText(now = new Date()) {
  const activeReminders = habitsCache
    .filter((habit) => habit.isActive && timeToMinutes(habit.reminder) !== null)
    .map((habit) => ({
      name: habit.name,
      reminder: habit.reminder,
      minutes: timeToMinutes(habit.reminder)
    }))
    .sort((a, b) => a.minutes - b.minutes);

  if (!activeReminders.length) return "No active reminders.";

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const nextToday = activeReminders.find((habit) => habit.minutes >= currentMinutes);
  const next = nextToday || activeReminders[0];
  const suffix = nextToday ? "today" : "tomorrow";

  return `Next: ${next.name} at ${next.reminder} ${suffix}.`;
}

async function showHabitNotification(habit) {
  return notifyUser(
    "Habit Reminder",
    {
      body: `Time to do your habit: ${habit.name}`,
      tag: `habit-${habit.id}-${getLocalDateString()}-${habit.reminder}`,
      requireInteraction: true,
      data: { habitId: habit.id }
    },
    "reminder"
  );
}

function getColorForHabit(value) {
  const palette = [
    "rgba(46, 125, 50, 0.72)",
    "rgba(21, 101, 192, 0.72)",
    "rgba(239, 108, 0, 0.72)",
    "rgba(106, 27, 154, 0.72)",
    "rgba(0, 121, 107, 0.72)",
    "rgba(198, 40, 40, 0.72)"
  ];

  const key = String(value || "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) % palette.length;
  }

  return palette[hash];
}

async function checkBrowserReminders(options = {}) {
  const now = new Date();
  const checkedAt = getCurrentSecondString(now);

  if (!("Notification" in window)) {
    setReminderCheckStatus(`Last checked ${checkedAt}; notifications are not supported.`, "error");
    updateNotificationControls();
    return;
  }

  if (Notification.permission !== "granted") {
    setReminderCheckStatus(
      `Last checked ${checkedAt}; notifications are not enabled.`,
      "info"
    );
    updateNotificationControls();
    return;
  }

  const today = getLocalDateString();
  const dueHabits = getDueHabits(now);
  let sentCount = 0;

  for (const habit of dueHabits) {
    const notificationKey = `${habit.id}:${today}:${habit.reminder}`;
    if (lastNotificationKeys.has(notificationKey)) continue;

    await showHabitNotification(habit);

    lastNotificationKeys.add(notificationKey);
    sentCount += 1;
  }

  if (lastNotificationKeys.size > 200) {
    lastNotificationKeys = new Set(Array.from(lastNotificationKeys).slice(-100));
  }

  if (sentCount) {
    setReminderCheckStatus(`Sent ${sentCount} reminder(s) at ${checkedAt}.`, "success");
    return;
  }

  const prefix = options.manual ? "No reminder due right now." : `Last checked ${checkedAt}.`;
  setReminderCheckStatus(`${prefix} ${getNextReminderText(now)}`, "info");
}

function initAuthPage() {
  if (!document.body.classList.contains("auth-page")) return;

  if (getToken()) {
    window.location.href = "dashboard.html";
    return;
  }

  document.getElementById("loginTab").addEventListener("click", () => switchAuthMode("login"));
  document.getElementById("signupTab").addEventListener("click", () => switchAuthMode("signup"));
  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("signupForm").addEventListener("submit", handleSignup);
}

async function initDashboard() {
  if (!document.body.classList.contains("dashboard-page")) return;

  try {
    const user = await verifySession();
    if (!user) return;

    document.getElementById("usernameDisplay").textContent = user.username;
    document.getElementById("logoutBtn").addEventListener("click", logout);
    document.getElementById("habitForm").addEventListener("submit", saveHabit);
    document.getElementById("cancelEditBtn").addEventListener("click", resetHabitForm);
    document.getElementById("refreshBtn").addEventListener("click", loadHabits);
    document.getElementById("badgeMenuBtn").addEventListener("click", openBadgeSidebar);
    document.getElementById("badgeCloseBtn").addEventListener("click", closeBadgeSidebar);
    document.getElementById("sidebarBackdrop").addEventListener("click", closeBadgeSidebar);
    document.getElementById("trackingDate").addEventListener("change", (event) => {
      setSelectedDate(event.target.value);
    });
    document.getElementById("prevDateBtn").addEventListener("click", () => shiftSelectedDate(-1));
    document.getElementById("nextDateBtn").addEventListener("click", () => shiftSelectedDate(1));
    document.getElementById("todayDateBtn").addEventListener("click", () => {
      setSelectedDate(getLocalDateString());
    });
    document
      .getElementById("enableNotificationsBtn")
      .addEventListener("click", enableNotifications);
    document
      .getElementById("testNotificationBtn")
      .addEventListener("click", sendTestNotification);
    document
      .getElementById("checkRemindersBtn")
      .addEventListener("click", () => {
        checkBrowserReminders({ manual: true }).catch(() => undefined);
      });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeBadgeSidebar();
    });

    updateNotificationControls();

    await loadHabits();
    window.setInterval(() => {
      checkBrowserReminders().catch(() => undefined);
    }, REMINDER_CHECK_INTERVAL_MS);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initAuthPage();
  initDashboard();
});
