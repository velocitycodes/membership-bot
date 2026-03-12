const Database = require('better-sqlite3');
const path = require('path');

const isVercel = process.env.VERCEL === '1';
const DB_PATH = isVercel ? path.join('/tmp', 'bot_database.db') : path.join(__dirname, 'bot_database.db');

const db = new Database(DB_PATH);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId INTEGER PRIMARY KEY,
    username TEXT,
    membershipToken TEXT UNIQUE,
    membershipExpiry TEXT,
    status TEXT DEFAULT 'none',
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    username TEXT,
    plan TEXT,
    amount INTEGER,
    transactionId TEXT UNIQUE,
    status TEXT DEFAULT 'pending',
    submittedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    processedAt TEXT
  );
`);

const User = {
    findOne: (query) => {
        const { userId } = query;
        return db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
    },
    create: (data) => {
        const { userId, username } = data;
        db.prepare('INSERT INTO users (userId, username) VALUES (?, ?)').run(userId, username);
        return User.findOne({ userId });
    },
    findOneAndUpdate: (query, update, options = {}) => {
        const { userId } = query;
        const keys = Object.keys(update);
        const setClause = keys.map(key => `${key} = ?`).join(', ');
        // SQLite better-sqlite3 doesn't handle Date objects, convert to ISO string
        const values = Object.values(update).map(v => v instanceof Date ? v.toISOString() : v);

        if (options.upsert) {
            const user = User.findOne({ userId });
            if (!user) {
                const insertKeys = ['userId', ...keys];
                const insertValues = [userId, ...values];
                const placeholders = insertKeys.map(() => '?').join(', ');
                db.prepare(`INSERT INTO users (${insertKeys.join(', ')}) VALUES (${placeholders})`).run(...insertValues);
                return User.findOne({ userId });
            }
        }

        db.prepare(`UPDATE users SET ${setClause} WHERE userId = ?`).run(...values, userId);
        return User.findOne({ userId });
    }
};

const Transaction = {
    create: (data) => {
        const { userId, username, plan, amount, transactionId, status } = data;
        db.prepare(`
            INSERT INTO transactions (userId, username, plan, amount, transactionId, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, username, plan, amount, transactionId, status || 'pending');
    },
    findOneAndUpdate: (query, update) => {
        const { userId, status: queryStatus } = query;
        const keys = Object.keys(update);
        const setClause = keys.map(key => `${key} = ?`).join(', ');
        // SQLite better-sqlite3 doesn't handle Date objects, convert to ISO string
        const values = Object.values(update).map(v => v instanceof Date ? v.toISOString() : v);

        db.prepare(`
            UPDATE transactions SET ${setClause} 
            WHERE userId = ? AND status = ?
        `).run(...values, userId, queryStatus);
    }
};

module.exports = { User, Transaction, db };
