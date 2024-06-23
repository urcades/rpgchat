const db = require('../db/setup');
const { awardGold } = require('../utils/goldUtils');
const { handleAttack } = require('../utils/attackUtils');
const { calculateLevel, calculateExperienceRequired } = require('../utils/leveling');
const eventBus = require('../eventBus');

function updateExperienceAndLevel(username, experienceGained, callback) {
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      console.error('Error fetching user:', err);
      return callback(err);
    }

    const { ExperienceCount, ExperienceRequired, level } = user;
    const newExperienceCount = ExperienceCount + experienceGained;
    const levelsGained = Math.floor(newExperienceCount / ExperienceRequired);

    if (levelsGained > 0) {
      const newLevel = level + levelsGained;
      const newExperienceRequired = calculateExperienceRequired(newLevel);
      const remainingExperience = newExperienceCount % ExperienceRequired;

      db.run('UPDATE users SET level = ?, ExperienceRequired = ?, ExperienceCount = ?, attributePoints = attributePoints + ? WHERE username = ?', 
        [newLevel, newExperienceRequired, remainingExperience, levelsGained * 10, username], 
        (err) => {
          if (err) {
            console.error('Error updating level and experience:', err);
            return callback(err);
          }
          callback(null, { leveledUp: true, newLevel, experienceGained });
        }
      );
    } else {
      db.run('UPDATE users SET ExperienceCount = ? WHERE username = ?', 
        [newExperienceCount, username], 
        (err) => {
          if (err) {
            console.error('Error updating experience count:', err);
            return callback(err);
          }
          callback(null, { leveledUp: false, experienceGained });
        }
      );
    }
  });
}

function handlePlayerKilled(playerName, attackerName, row, col) {
  const systemMessage = `${playerName} has been killed by ${attackerName}`;

  db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [systemMessage], (err) => {
    if (err) {
      console.error('Error inserting system message:', err);
    }
  });

  updateExperienceAndLevel(attackerName, 50, (err, result) => {
    if (err) {
      console.error('Error updating attacker experience:', err);
    } else {
      let killMessage = `${attackerName} gained 50 experience points for killing ${playerName}.`;
      if (result.leveledUp) {
        killMessage += ` ${attackerName} leveled up to level ${result.newLevel}!`;
      }
      db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [killMessage], (err) => {
        if (err) {
          console.error('Error inserting kill message:', err);
        }
      });
    }
  });
}

module.exports = {
  handleAttack: (req, res) => {
    const username = req.session.user.username;
    const message = req.body.message;
    const row = req.params.row;
    const col = req.params.col;

    handleAttack(username, message, row, col, (err, updatedMessage) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES (?, ?)`, [username, updatedMessage], (err) => {
        if (err) {
          return res.status(500).send("Internal Server Error");
        }

        db.run("UPDATE users SET stamina = MAX(stamina - 1, 0) WHERE username = ?", [username], (err) => {
          if (err) {
            return res.status(500).send("Internal Server Error");
          }

          awardGold(username);

          db.run("UPDATE tick SET value = value + 1 WHERE rowid = 1", (err) => {
            if (err) {
              return res.status(500).send("Internal Server Error");
            }

            updateExperienceAndLevel(username, 1, (err, result) => {
              if (err) {
                return res.status(500).send("Internal Server Error");
              }

              let systemMessage = `${username} gained 1 experience point for attacking.`;
              if (result.leveledUp) {
                systemMessage += ` ${username} leveled up to level ${result.newLevel}!`;
              }

              db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [systemMessage], (err) => {
                if (err) {
                  console.error('Error inserting system message:', err);
                }

                eventBus.emit('newMessage', { username, message: updatedMessage });
                res.redirect(`/chat/${row}/${col}`);
              });
            });
          });
        });
      });
    });
  }
};