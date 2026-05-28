const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const chatController = require('../controllers/chatController');
const attackController = require('../controllers/attackController');
const actionController = require('../controllers/actionController');
const skillController = require('../controllers/skillController');
const jobController = require('../controllers/jobController');

router.post('/chat/:row/:col', authMiddleware, chatController.handleChat);
router.post('/attack/:row/:col', authMiddleware, attackController.handleAttack);
router.post('/skill/:row/:col', authMiddleware, skillController.handleSkill);
router.post('/job/:row/:col', authMiddleware, jobController.handleJobChange);
router.post('/action', authMiddleware, actionController.handleAction);

module.exports = router;
