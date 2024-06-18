const db = require('../db/setup');
const { calculateLevel } = require('../utils/leveling');
const eventBus = require('../eventBus');
const { awardGold } = require('../utils/goldUtils');

module.exports = {
  handleChat: (req, res) => {
    const username = req.session.user.username;
    const message = req.body.message;
    const row = req.params.row;
    const col = req.params.col;

    db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES (?, ?)`, [username, message], (err) => {
      if (err) {
        console.error('Error inserting message:', err);
        return res.status(500).send('Internal Server Error');
      }

      db.run('UPDATE users SET stamina = MAX(stamina - 1, 0) WHERE username = ?', [username], (err) => {
        if (err) {
          console.error('Error updating stamina:', err);
          return res.status(500).send('Internal Server Error');
        }

        awardGold(username);

        db.run('UPDATE tick SET value = value + 1 WHERE rowid = 1', (err) => {
          if (err) {
            console.error('Error updating tick:', err);
            return res.status(500).send('Internal Server Error');
          }

          db.get(`SELECT COUNT(*) AS messageCount FROM messages_${row}_${col} WHERE username = ?`, [username], (err, row) => {
            if (err) {
              console.error('Error getting message count:', err);
              return res.status(500).send('Internal Server Error');
            }

            const newLevel = calculateLevel(row.messageCount);
            db.get('SELECT level FROM users WHERE username = ?', [username], (err, user) => {
              if (err) {
                console.error('Error getting user level:', err);
                return res.status(500).send('Internal Server Error');
              }

              if (newLevel > user.level) {
                db.run('UPDATE users SET level = ?, attributePoints = attributePoints + 10 WHERE username = ?', [newLevel, username], (err) => {
                  if (err) {
                    console.error('Error updating user level:', err);
                    return res.status(500).send('Internal Server Error');
                  }

                  eventBus.emit('newMessage', { username, message });
                  res.redirect(`/chat/${row}/${col}`);
                });
              } else {
                eventBus.emit('newMessage', { username, message });
                res.redirect(`/chat/${row}/${col}`);
              }
            });
          });
        });
      });
    });
  },
};