<<<<<<< HEAD
# 🚀 Taskforce Traitors — Campus Social Deduction Platform

**Taskforce Traitors** is a real-time web application built to run physical, campus-wide social deduction games (*Among Us / The Traitors* style) for **60 players across 20 teams of 3**.

---

## 🌟 Key Features

- **Random Secret Role Assignment**: 15 Crew Teams vs 5 Imposter Teams with cryptographic nonces and hidden volunteer session routing.
- **Station Task Management**: 12 Task Types (Trivia, MCQ, Puzzle, Photo Upload, Physical Verification, Speed Challenge, Code Cracker, Sequence, Cipher, Pattern Match, Riddle, Team Coordination).
- **Auto-Grading & EXIF-Stripped Proof Uploads**: Client and server side verification with image metadata stripping.
- **Imposter Secret Kills Pipeline**: Imposter-initiated kill reporting requiring victim team acknowledgment or admin override.
- **Emergency Meetings & Confidential Voting**: Auto-timed discussion and voting phases with Socket.io real-time broadcast.
- **Full Admin Control Dashboard**: Real-time team metrics, task verifications, kill approvals, meeting overrides, manual role reveals, and score recalculations.
- **Spectator / Projector Display**: Cinematic HUD with global crew task progress bar, dynamic leaderboard, live activity feed, and full-screen meeting/victory overlays.
- **Mobile PWA Volunteer App**: Optimized for phones with offline caching capabilities and responsive UI.

---

## 📁 Architecture Overview

```
Taskforce Traitors/
├── database/
│   └── db.js            # SQLite database schema, initialization, and queries
├── middleware/
│   ├── auth.js          # Express authentication middleware & session guards
│   └── roles.js         # Secret role privacy enforcement middleware
├── public/
│   ├── admin/           # Admin Control Panel HUD
│   ├── login/           # Unified Portal Login (Admin & Volunteer PIN)
│   ├── projector/       # Spectator / Big Screen Stage Display
│   └── volunteer/       # PWA Mobile Control App for Volunteers
├── routes/
│   ├── admin.js         # Admin management endpoints
│   ├── auth.js          # Authentication API
│   ├── game.js          # Game state & phase control
│   ├── public.js        # Safe public read-only state endpoints
│   └── volunteer.js     # Station, Task, Kill, and Meeting endpoints
├── services/
│   ├── assignmentEngine.js # Team & Station assignment logic
│   ├── gameEngine.js       # Game phase management
│   ├── roleEngine.js       # Secret role generation & security
│   ├── scoringEngine.js    # Leaderboard & points calculator
│   └── taskEngine.js       # Task submission & auto-grading engine
├── socket/
│   ├── gameSocket.js       # Core real-time socket events & heartbeat
│   ├── meetingSocket.js    # Timer & voting lifecycle socket server
│   └── taskSocket.js       # Timed task expiration background worker
├── .env.example
├── package.json
└── server.js               # Entry point
```

---

## ⚙️ Installation & Running

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Configuration**:
   Create a `.env` file in the root directory:
   ```env
   PORT=3000
   SESSION_SECRET=super_secret_taskforce_key
   ADMIN_PASSWORD=admin123
   DATABASE_PATH=./database/game.sqlite
   ```

3. **Start Server**:
   ```bash
   npm run dev
   # or
   npm start
   ```

4. **Access Portals**:
   - **Login**: `http://localhost:3000/login/`
   - **Admin Dashboard**: `http://localhost:3000/admin/` (Login with ADMIN_PASSWORD)
   - **Volunteer App**: `http://localhost:3000/volunteer/` (Login with Team PIN)
   - **Projector / Big Screen**: `http://localhost:3000/projector/`

---

## 🔐 Role Security

- Imposter roles are strictly filtered at the database query layer (`middleware/roles.js`).
- Role information is never sent to public endpoints or crew volunteer sessions.
- Socket.io rooms strictly isolate `admin`, `imposter_secret`, and public channels.
=======
# Taskforce-Traitors
>>>>>>> e1fdbd4fc22eb3b3816f2ef29d739e50b497a2df
