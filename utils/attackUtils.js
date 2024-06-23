const db = require('../db/setup');

function handlePlayerKilled(playerName, attackerName, row, col) {
  const systemMessage = `${playerName} has been killed by ${attackerName}`;

  db.get("SELECT * FROM users WHERE username = 'System'", (err, systemUser) => {
    if (err) {
      console.error('Error checking for System user:', err);
      return;
    }

    if (!systemUser) {
      // If the System user doesn't exist, create it
      db.run(`INSERT INTO users (username, password, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
              VALUES ('System', 'system', 9999, 9999, 9999, 9999, 9999, 9999, 9999, 0, 9999)`, (err) => {
        if (err) {
          console.error('Error creating System user:', err);
          return;
        }
        insertSystemMessage();
      });
    } else {
      insertSystemMessage();
    }
  });

  function insertSystemMessage() {
    db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [systemMessage], (err) => {
      if (err) {
        console.error('Error inserting system message:', err);
      }
    });
  }

  // Grant 50 experience points to the attacker
  db.run("UPDATE users SET ExperienceCount = ExperienceCount + 50 WHERE username = ?", [attackerName], (err) => {
    if (err) {
      console.error('Error updating experience count for attacker:', err);
    }
  });
}

function handleAttack(username, message, row, col, callback) {
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

        // Check for critical attack (1% chance)
        const isCriticalAttack = Math.random() < 0.01;
        const damage = isCriticalAttack ? 2 : 1;

        db.run("UPDATE users SET health = health - ? WHERE username = ? AND health > 0", [damage, user.username], (err) => {
          if (err) {
            console.error("Error decrementing health:", err);
            return callback(err);
          }
          console.log(`${user.username} was attacked and lost ${damage} health.`);
          
          const attackMessage = isCriticalAttack ? 
            `${username} landed a critical hit on ${user.username} for ${damage} damage!` :
            `${username} attacked ${user.username} for ${damage} damage`;
          attackMessages.push(attackMessage);

          db.get("SELECT * FROM users WHERE username = ?", [user.username], (err, attackedUser) => {
            if (err) {
              console.error("Error retrieving user:", err);
              return callback(err);
            }

            if (attackedUser && attackedUser.health <= 0) {
              db.run("INSERT INTO cemetery (username, password, level, gold) SELECT username, '', level, gold FROM users WHERE username = ?", [user.username], (err) => {
                if (err) {
                  console.error("Error moving user to cemetery:", err);
                  return callback(err);
                }

                db.run("DELETE FROM users WHERE username = ?", [user.username], (err) => {
                  if (err) {
                    console.error("Error deleting user:", err);
                    return callback(err);
                  }

                  console.log(`${user.username} has been moved to the cemetery.`);
                  handlePlayerKilled(user.username, username, row, col);
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

module.exports = {
  handleAttack
};