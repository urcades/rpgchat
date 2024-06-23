const express = require('express');
const path = require('path');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.use('/', require('./auth'));
router.use('/', require('./chat'));
router.use('/', require('./messages'));
router.use('/', require('./tick'));
router.use('/', require('./userAttributes'));
router.use('/', require('./inventory'));
router.use('/', require('./userInventory'));
router.use('/', require('./updateAttributes'));

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

router.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'signup.html'));
});

router.get('/success', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'success.html'));
});

router.get('/protected', require('../middleware/auth'), (req, res) => {
  res.send('This is a protected page. Only logged-in users can see this.');
});

router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.redirect('/');
  });
});

router.get('/chat/:row/:col', authMiddleware, (req, res) => {
  const row = parseInt(req.params.row);
  const col = parseInt(req.params.col);
  res.render('chat', { row, col, user: req.session.user }); // Pass the user object
});

router.get('/character', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'character.html'));
});

router.get('/cemetery', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'cemetery.html'));
});

router.get('/cemetery-data', (req, res) => {
  db.all("SELECT username, level, gold FROM cemetery", (err, players) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(players);
  });
});

router.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'leaderboard.html'));
});

router.get('/leaderboard-data', (req, res) => {
  db.all("SELECT username, gold FROM users ORDER BY gold DESC", (err, players) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(players);
  });
});

router.get('/chat/:row/:col', require('../middleware/auth'), (req, res) => {
  const row = parseInt(req.params.row);
  const col = parseInt(req.params.col);
  res.sendFile(path.join(__dirname, '../public', 'chat.html'));
});

router.post('/update-class', authMiddleware, (req, res) => {
  const username = req.session.user.username;
  const selectedClass = req.body.class;

  db.run("UPDATE users SET class = ? WHERE username = ?", [selectedClass, username], (err) => {
    if (err) {
      console.error("Error updating class:", err);
      return res.status(500).send("Internal Server Error");
    }
    res.sendStatus(200);
  });
});

router.post('/train/:row/:col', authMiddleware, (req, res) => {
  const username = req.session.user.username;
  const row = req.params.row;
  const col = req.params.col;

  // Roll a 20-sided dice
  const roll = Math.floor(Math.random() * 20) + 1;

  // Determine the experience points based on the roll
  let experiencePoints = 0;
  if (roll > 18) {
    experiencePoints = Math.floor(Math.random() * 5) + 1;
  }

  // Update the user's experience count in the database
  db.run("UPDATE users SET ExperienceCount = ExperienceCount + ? WHERE username = ?", [experiencePoints, username], (err) => {
    if (err) {
      console.error("Error updating experience count:", err);
      return res.status(500).send("Internal Server Error");
    }

    // Create a pseudo message based on the roll and experience points
    let message = '';
    if (roll > 18) {
      message = `${username} trained vigorously and gained ${experiencePoints} experience points!`;
    } else {
      message = `${username} trained, but didn't gain any experience points.`;
    }

    // Insert the pseudo message into the chat messages table
    db.run(`INSERT INTO messages_${row}_${col} (username, message) VALUES (?, ?)`, ['System', message], (err) => {
      if (err) {
        console.error("Error inserting pseudo message:", err);
        return res.status(500).send("Internal Server Error");
      }

      res.json({ roll, experiencePoints });
    });
  });
});

router.post('/treasure-hunt', authMiddleware, (req, res) => {
  const username = req.session.user.username;

  // Roll a 20-sided dice
  const roll = Math.floor(Math.random() * 20) + 1;

  // Determine the amount of gold based on the roll
  let goldAmount = 0;
  if (roll > 15) {
    goldAmount = Math.floor(Math.random() * 6) + 5; // Random gold between 5 and 10
  }

  // Update the user's gold in the database if a successful roll is made
  if (goldAmount > 0) {
    db.run("UPDATE users SET gold = gold + ? WHERE username = ?", [goldAmount, username], (err) => {
      if (err) {
        console.error("Error updating gold:", err);
        return res.status(500).send("Internal Server Error");
      }
      res.json({ roll, goldAmount });
    });
  } else {
    res.json({ roll, goldAmount });
  }
});

module.exports = router;