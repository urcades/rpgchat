const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const db = require('./db/setup'); // Ensure this runs and initializes the DB
const routes = require('./routes/index');
const WebSocket = require('ws');
const eventBus = require('./eventBus'); // Import the event bus

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(routes);

const PORT = 3333;
const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

eventBus.on('newMessage', (message) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
});