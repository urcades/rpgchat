const db = require('../db/setup');

module.exports = {
  handleAction: (req, res) => {
    const username = req.session.user.username;

    db.run("UPDATE users SET clicks = clicks + 1 WHERE username = ?", [username], (err) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }
      res.sendStatus(200);
    });
  }
};