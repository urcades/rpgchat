const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');
const { calculateLevel } = require('../utils/leveling');
const eventBus = require('../eventBus'); // Import the event bus

// Function to award gold with a low probability
function awardGold(username) {
  const probability = 0.1; // 10% chance to award gold
  if (Math.random() < probability) {
    const goldAmount = Math.floor(Math.random() * 3) + 1; // Random value between 1 and 3
    db.run("UPDATE users SET gold = gold + ? WHERE username = ?", [goldAmount, username], (err) => {
      if (err) {
        console.error("Error awarding gold:", err);
      } else {
        console.log(`${username} was awarded ${goldAmount} gold.`);
      }
    });
  }
}

// Function to handle attacks
// Function to handle attacks
function handleAttack(username, message, callback) {
  db.all("SELECT username FROM users", (err, users) => {
    if (err) {
      console.error("Database error: ", err);
      return callback(err);
    }

    let attackMessages = [];
    let userAttacked = false;
    let tasksRemaining = users.length;

    users.forEach(user => {
      if (message.includes(user.username)) {
        userAttacked = true;
        db.run("UPDATE users SET health = health - 1 WHERE username = ? AND health > 0", [user.username], (err) => {
          if (err) {
            console.error("Error decrementing health:", err);
            return callback(err);
          }
          console.log(`${user.username} was attacked and lost 1 health.`);
          attackMessages.push(`${username} attacked ${user.username} for 1 damage`);

          // Check if the user's health has reached 0
          db.get("SELECT * FROM users WHERE username = ?", [user.username], (err, attackedUser) => {
            if (err) {
              console.error("Error retrieving user:", err);
              return callback(err);
            }

            if (attackedUser && attackedUser.health <= 0) {
              // Move the user to the "cemetery" table
              db.run("INSERT INTO cemetery (username, password, level, gold) SELECT username, '', level, gold FROM users WHERE username = ?", [user.username], (err) => {
                if (err) {
                  console.error("Error moving user to cemetery:", err);
                  return callback(err);
                }

                // Delete the user from the "users" table
                db.run("DELETE FROM users WHERE username = ?", [user.username], (err) => {
                  if (err) {
                    console.error("Error deleting user:", err);
                    return callback(err);
                  }

                  console.log(`${user.username} has been moved to the cemetery.`);
                  tasksRemaining -= 1;
                  if (tasksRemaining === 0) {
                    const updatedMessage = `${message} (${attackMessages.join(', ')})`;
                    callback(null, updatedMessage);
                  }
                });
              });
            } else {
              tasksRemaining -= 1;
              if (tasksRemaining === 0) {
                const updatedMessage = `${message} (${attackMessages.join(', ')})`;
                callback(null, updatedMessage);
              }
            }
          });
        });
      } else {
        tasksRemaining -= 1;
        if (tasksRemaining === 0) {
          if (attackMessages.length > 0) {
            const updatedMessage = `${message} (${attackMessages.join(', ')})`;
            callback(null, updatedMessage);
          } else {
            callback(null, message);
          }
        }
      }
    });
  });
}

router.post('/chat', authMiddleware, (req, res) => {
  const username = req.session.user.username;
  const message = req.body.message;

  db.run("INSERT INTO messages (username, message) VALUES (?, ?)", [username, message], (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }

    // Decrement stamina by 1
    db.run("UPDATE users SET stamina = stamina - 1 WHERE username = ? AND stamina > 0", [username], (err) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      // Award gold with a low probability
      awardGold(username);

      db.run("UPDATE tick SET value = value + 1 WHERE rowid = 1", (err) => {
        if (err) {
          return res.status(500).send("Internal Server Error");
        }

        db.get("SELECT COUNT(*) AS messageCount FROM messages WHERE username = ?", [username], (err, row) => {
          if (err) {
            return res.status(500).send("Internal Server Error");
          }
          const newLevel = calculateLevel(row.messageCount);
          db.get("SELECT level FROM users WHERE username = ?", [username], (err, user) => {
            if (err) {
              return res.status(500).send("Internal Server Error");
            }
            if (newLevel > user.level) {
              db.run("UPDATE users SET level = ?, attributePoints = attributePoints + 10 WHERE username = ?", [newLevel, username], (err) => {
                if (err) {
                  return res.status(500).send("Internal Server Error");
                }
                eventBus.emit('newMessage', { username, message });
                res.redirect('/chat');
              });
            } else {
              eventBus.emit('newMessage', { username, message });
              res.redirect('/chat');
            }
          });
        });
      });
    });
  });
});

router.post('/attack', authMiddleware, (req, res) => {
  const username = req.session.user.username;
  const message = req.body.message;

  handleAttack(username, message, (err, updatedMessage) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }

    db.run("INSERT INTO messages (username, message) VALUES (?, ?)", [username, updatedMessage], (err) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      // Decrement stamina by 1
      db.run("UPDATE users SET stamina = stamina - 1 WHERE username = ? AND stamina > 0", [username], (err) => {
        if (err) {
          return res.status(500).send("Internal Server Error");
        }

        // Award gold with a low probability
        awardGold(username);

        db.run("UPDATE tick SET value = value + 1 WHERE rowid = 1", (err) => {
          if (err) {
            return res.status(500).send("Internal Server Error");
          }

          db.get("SELECT COUNT(*) AS messageCount FROM messages WHERE username = ?", [username], (err, row) => {
            if (err) {
              return res.status(500).send("Internal Server Error");
            }
            const newLevel = calculateLevel(row.messageCount);
            db.get("SELECT level FROM users WHERE username = ?", [username], (err, user) => {
              if (err) {
                return res.status(500).send("Internal Server Error");
              }
              if (newLevel > user.level) {
                db.run("UPDATE users SET level = ?, attributePoints = attributePoints + 10 WHERE username = ?", [newLevel, username], (err) => {
                  if (err) {
                    return res.status(500).send("Internal Server Error");
                  }
                  eventBus.emit('newMessage', { username, message: updatedMessage });
                  res.redirect('/chat');
                });
              } else {
                eventBus.emit('newMessage', { username, message: updatedMessage });
                res.redirect('/chat');
              }
            });
          });
        });
      });
    });
  });
});

router.post('/action', authMiddleware, (req, res) => {
  const username = req.session.user.username;

  db.run("UPDATE users SET clicks = clicks + 1 WHERE username = ?", [username], (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.sendStatus(200);
  });
});

module.exports = router;