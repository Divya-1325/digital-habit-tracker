# Digital Habit Tracker

A MySQL-backed habit reminder app with sign-up, login, editable habit reminders, completion tracking, browser notifications, and weekly progress charts.

## Features

- Sign up with username, email, and password
- Login with email or username
- Token-based sessions stored in MySQL
- MySQL database and table creation on server startup
- Add, edit, pause/resume, and delete habits
- Store reminder time, notes, active status, and completion history
- Mark today as done or not done
- Streak badge ladder from 0+ to 365+ days
- Weekly progress chart with Chart.js
- Browser notifications while the dashboard is open
- Optional email reminders through Nodemailer

## Database

The app uses MySQL only. On startup, the backend creates this database if it does not exist:

```text
digital_habit_tracker
```

It also creates these tables:

- `users`
- `sessions`
- `habits`
- `habit_logs`

The same schema is available in `backend/schema.sql`.

Existing databases are migrated on startup to add the `users.username` column if it is missing.

## Setup

Install MySQL, then create `backend/.env` from `backend/.env.example`:

```env
PORT=5000
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=digital_habit_tracker
```

Then run:

```bash
cd backend
npm install
npm start
```

Open `http://localhost:5000`.

## Email Reminders

Email reminders are disabled unless these values are set in `backend/.env`:

```env
EMAIL_SERVICE=gmail
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM=your_email@gmail.com
```

For Gmail, `EMAIL_PASS` should be a Gmail app password.

## API

- `POST /auth/signup` with `username`, `email`, and `password`
- `POST /auth/login` with `identifier` and `password`
- `POST /auth/logout`
- `GET /auth/me`
- `GET /habits`
- `POST /habits`
- `PUT /habits/:id`
- `PUT /habits/:id/completion`
- `PATCH /habits/:id/toggle-today`
- `DELETE /habits/:id`

## Tests

```bash
cd backend
npm test
```
