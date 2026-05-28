const db = require('../db/setup');

const authMiddleware = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  db.get('SELECT username FROM users WHERE username = ?', [req.session.user.username], (userErr, user) => {
    if (userErr) {
      return res.status(500).send('Internal Server Error');
    }

    if (user) {
      return next();
    }

    db.get(
      'SELECT username FROM cemetery WHERE username = ? ORDER BY diedAt DESC, rowid DESC LIMIT 1',
      [req.session.user.username],
      (cemeteryErr, deadUser) => {
        if (cemeteryErr) {
          return res.status(500).send('Internal Server Error');
        }

        if (deadUser) {
          req.session.deadUser = { username: deadUser.username };
          delete req.session.user;

          if (req.path.startsWith('/user-attributes') || req.path.startsWith('/messages') || req.path.startsWith('/room-ecology')) {
            return res.status(410).json({ error: 'You died', redirect: '/death' });
          }

          return res.redirect('/death');
        }

        req.session.destroy(() => {
          res.redirect('/');
        });
      }
    );
  });
};

module.exports = authMiddleware;
