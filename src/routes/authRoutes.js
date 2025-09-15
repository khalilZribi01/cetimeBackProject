// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');

// Branche DIRECTEMENT sur le service IMAP (plus simple et explicite)
const { getUnreadCount } = require('../services/gmailImapService');
const allowedCtrl = require("../controllers/allowedController");

router.post('/login', authController.login);
router.post('/register', authController.register);

router.get('/summary', authController.getUserStats);
router.get('/clients', authController.getClients);
router.get('/user/:id', requireAuth, authController.getUserById);
router.put('/user/:id', requireAuth, authController.updateUser);

// Gmail → compteur non lus (IMAP)
router.get('/gmail/unread-count', getUnreadCount);
router.get("/allowed", allowedCtrl.getAllowedAgents);
module.exports = router;
