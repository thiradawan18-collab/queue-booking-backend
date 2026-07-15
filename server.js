import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory storage (ใช้ชั่วคราว)
let queues = [];
let queueCounter = 1;

// LINE Configuration
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';

// API Routes
app.get('/api/queues', (req, res) => {
  res.json({ queues });
});

app.post('/api/queues', (req, res) => {
  const { lineUserName, type, duration, appointmentDate, appointmentTime } = req.body;

  if (!lineUserName) {
    return res.status(400).json({ error: 'lineUserName is required' });
  }

  const newQueue = {
    id: queueCounter++,
    lineUserName,
    type, // 'print' or 'phone'
    duration, // 15, 30, 60 (minutes)
    appointmentDate,
    appointmentTime,
    status: 'waiting', // waiting, called, completed
    createdAt: new Date(),
  };

  queues.push(newQueue);

  // Send notification to LINE OA
  if (LINE_CHANNEL_ACCESS_TOKEN) {
    sendLineNotification(`มีการจองคิวใหม่ - ${lineUserName}`);
  }

  res.json({ success: true, queue: newQueue });
});

app.post('/api/queues/:id/call', (req, res) => {
  const queue = queues.find(q => q.id === parseInt(req.params.id));
  if (!queue) {
    return res.status(404).json({ error: 'Queue not found' });
  }

  queue.status = 'called';

  // Send notification to customer
  if (LINE_CHANNEL_ACCESS_TOKEN) {
    sendLineNotification(`เรียกคิวของ ${queue.lineUserName}`);
  }

  res.json({ success: true, queue });
});

app.post('/api/queues/:id/complete', (req, res) => {
  const queue = queues.find(q => q.id === parseInt(req.params.id));
  if (!queue) {
    return res.status(404).json({ error: 'Queue not found' });
  }

  queue.status = 'completed';

  // Send notification to customer
  if (LINE_CHANNEL_ACCESS_TOKEN) {
    sendLineNotification(`ปิดคิวของ ${queue.lineUserName}`);
  }

  res.json({ success: true, queue });
});

// Helper function to send LINE notification
async function sendLineNotification(message) {
  try {
    await axios.post(
      'https://api.line.biz/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text: message }] },
      {
        headers: {
          'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error sending LINE notification:', error.message);
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Queue Booking Backend is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
