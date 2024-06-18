const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const chatController = require('../controllers/chatController');
const attackController = require('../controllers/attackController');
const actionController = require('../controllers/actionController');

router.post('/chat/:row/:col', authMiddleware, chatController.handleChat);
router.post('/attack/:row/:col', authMiddleware, attackController.handleAttack);
router.post('/action', authMiddleware, actionController.handleAction);

module.exports = router;