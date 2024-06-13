const express = require('express');
const router = express.Router();
const db = require('../db/setup');

// router.post('/update-attributes', (req, res) => {
//     const { healthPoints, staminaPoints, speedPoints, strengthPoints, intelligencePoints } = req.body;
//     const username = req.session.user.username;

//     db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
//         if (err) {
//             return res.status(500).send("Internal Server Error");
//         }

//         const totalPointsUsed = healthPoints + staminaPoints + speedPoints + strengthPoints + intelligencePoints;
//         if (totalPointsUsed > user.attributePoints) {
//             return res.status(400).send("Not enough attribute points");
//         }

//         const updatedAttributePoints = user.attributePoints - totalPointsUsed;

//         db.run(`UPDATE users 
//                 SET attributePoints = ?,
//                     health = health,
//                     stamina = stamina,
//                     speed = speed,
//                     strength = strength,
//                     intelligence = intelligence
//                 WHERE username = ?`,
//             [updatedAttributePoints, username], (err) => {
//                 if (err) {
//                     return res.status(500).send("Internal Server Error");
//                 }
                
//                 // Insert the allocated points into a separate table
//                 db.run(`INSERT INTO attributeAllocations (username, healthPoints, staminaPoints, speedPoints, strengthPoints, intelligencePoints)
//                         VALUES (?, ?, ?, ?, ?, ?)`,
//                     [username, healthPoints, staminaPoints, speedPoints, strengthPoints, intelligencePoints], (err) => {
//                         if (err) {
//                             return res.status(500).send("Internal Server Error");
//                         }
//                         res.status(200).send("Attributes updated");
//                     });
//             });
//     });
// });

module.exports = router;