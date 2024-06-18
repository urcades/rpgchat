const db = require('../db/setup');

function awardGold(username) {
  const probability = 0.1;
  if (Math.random() < probability) {
    const goldAmount = Math.floor(Math.random() * 3) + 1;
    db.run("UPDATE users SET gold = gold + ? WHERE username = ?", [goldAmount, username], (err) => {
      if (err) {
        console.error("Error awarding gold:", err);
      } else {
        console.log(`${username} was awarded ${goldAmount} gold.`);
      }
    });
  }
}

module.exports = {
  awardGold
};