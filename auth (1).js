const db = require('../db/database');

// Attach user to req if valid session token present
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'] || req.session?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(token);
  if (!user) return res.status(401).json({ error: 'Session expired — please reconnect Meta' });

  // Update last seen
  db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(token);
  req.user = user;
  next();
}

module.exports = { requireAuth };
