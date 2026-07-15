const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const app = express();

// ============ CONFIGURATION ============
const LINE_LOGIN_CHANNEL_ID = '2010715428';
const LINE_LOGIN_CHANNEL_SECRET = '6a5eb3c09818d9addc4ff24a6e510959';
const LINE_MESSAGING_CHANNEL_SECRET = '6f7ac4440e3214679e640349feeabf5c';
const LINE_MESSAGING_ACCESS_TOKEN = 'k3/wRsBg/A/SonKzVWBBn67zrBY31u8DGhDmfBfkt9YZzTKvbEcy6YxQsEX+Hgfqt43q6aaEJiBpUjP3ZTRYBj8OBwyIJ8I3GKebc3HH5nyytVwxeFih7OKyIm9tKme6Mwued2XsqBa5GB88jhjx6AdB04t89/1O/w1cDnyilFU=';
const JWT_SECRET = 'your-secret-key-change-this';

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Create upload directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// ============ IN-MEMORY DATABASE ============
let queues = [];
let users = {};

// ============ LINE LOGIN ============
app.post('/api/line-login', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    // Exchange code for access token
    const response = await axios.post('https://api.line.me/oauth2/v2.1/token', null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI || 'http://localhost:3000/callback',
        client_id: LINE_LOGIN_CHANNEL_ID,
        client_secret: LINE_LOGIN_CHANNEL_SECRET
      }
    });

    const { access_token } = response.data;

    // Get user profile
    const profileResponse = await axios.get('https://api.line.me/v2/profile', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    const { userId, displayName, pictureUrl } = profileResponse.data;

    // Store user info
    users[userId] = {
      userId,
      displayName,
      pictureUrl,
      lineAccessToken: access_token
    };

    // Create JWT token
    const token = jwt.sign({ userId, displayName }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      success: true,
      token,
      user: {
        userId,
        displayName,
        pictureUrl
      }
    });
  } catch (error) {
    console.error('LINE Login Error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ VERIFY TOKEN ============
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ QUEUE BOOKING ============
app.post('/api/book-queue', verifyToken, upload.single('slip'), async (req, res) => {
  try {
    const { type, scheduledDate, scheduledTime, duration } = req.body;
    const { userId, displayName } = req.user;

    // Validate input
    if (!type || (type === 'phone' && (!scheduledDate || !scheduledTime || !duration))) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Slip image is required' });
    }

    // Check for time conflicts (phone booking only)
    if (type === 'phone') {
      const startTime = new Date(`${scheduledDate}T${scheduledTime}`);
      const durationMinutes = parseInt(duration);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      const hasConflict = queues.some(q => {
        if (q.type !== 'phone' || q.status === 'completed') return false;

        const qStart = new Date(q.scheduledTime);
        const qEnd = new Date(qStart.getTime() + parseInt(q.duration) * 60000);

        // Check if times overlap
        return (startTime < qEnd && endTime > qStart);
      });

      if (hasConflict) {
        fs.unlinkSync(req.file.path); // Delete uploaded file
        return res.status(409).json({ error: 'Time slot is already booked' });
      }
    }

    // Create queue entry
    const newQueue = {
      id: Date.now(),
      type,
      userId,
      displayName,
      slipPath: req.file.path,
      slipUrl: `/uploads/${req.file.filename}`,
      bookingTime: new Date().toISOString(),
      scheduledDate: scheduledDate || null,
      scheduledTime: scheduledTime || null,
      duration: duration || null,
      status: 'waiting', // waiting, called, completed
      queueNumber: queues.filter(q => q.status !== 'completed').length + 1
    };

    queues.push(newQueue);

    // Send LINE notification to owner
    await sendLineNotification(
      `🎫 มีการจองคิวใหม่\n👤 ชื่อ: ${displayName}\n📋 ประเภท: ${type === 'walkin' ? 'พิมพ์' : 'โทร'}\n${type === 'phone' ? `⏰ เวลา: ${scheduledDate} ${scheduledTime} (${duration} นาที)\n` : ''}✅ Slip: อัปโหลดแล้ว`
    );

    // Send LINE notification to customer
    await sendLineNotificationToUser(
      userId,
      `✅ จองคิวสำเร็จ!\n🎫 ลำดับที่: ${newQueue.queueNumber}\n📋 ประเภท: ${type === 'walkin' ? 'พิมพ์' : 'โทร'}\n${type === 'phone' ? `⏰ เวลา: ${scheduledDate} ${scheduledTime}\n` : ''}ขอบคุณที่ใช้บริการ`
    );

    res.json({
      success: true,
      queue: newQueue
    });
  } catch (error) {
    console.error('Booking Error:', error);
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Booking failed' });
  }
});

// ============ GET QUEUES ============
app.get('/api/queues', (req, res) => {
  try {
    const activeQueues = queues
      .filter(q => q.status !== 'completed')
      .sort((a, b) => a.queueNumber - b.queueNumber)
      .map(q => ({
        ...q,
        slipUrl: undefined // Don't expose file path
      }));

    res.json({ queues: activeQueues });
  } catch (error) {
    console.error('Get Queues Error:', error);
    res.status(500).json({ error: 'Failed to get queues' });
  }
});

// ============ CALL QUEUE ============
app.post('/api/call-queue/:queueId', verifyToken, async (req, res) => {
  try {
    const { queueId } = req.params;
    const queue = queues.find(q => q.id === parseInt(queueId));

    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    queue.status = 'called';

    // Send LINE notification to customer
    await sendLineNotificationToUser(
      queue.userId,
      `📢 เรียกคิวของคุณแล้ว!\n🎫 ลำดับที่: ${queue.queueNumber}\n👤 ${queue.displayName}\n⏱️ กรุณามาถึงจุดบริการ`
    );

    // Send notification to owner
    await sendLineNotification(`📢 เรียกคิวของ ${queue.displayName} (ลำดับที่ ${queue.queueNumber}) แล้ว`);

    res.json({ success: true });
  } catch (error) {
    console.error('Call Queue Error:', error);
    res.status(500).json({ error: 'Failed to call queue' });
  }
});

// ============ COMPLETE QUEUE ============
app.post('/api/complete-queue/:queueId', verifyToken, async (req, res) => {
  try {
    const { queueId } = req.params;
    const queue = queues.find(q => q.id === parseInt(queueId));

    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    queue.status = 'completed';

    // Send LINE notification to customer
    await sendLineNotificationToUser(
      queue.userId,
      `✅ คิวของคุณเสร็จสิ้นแล้ว!\n🎫 ลำดับที่: ${queue.queueNumber}\n👤 ${queue.displayName}\nขอบคุณที่ใช้บริการ`
    );

    // Send notification to owner
    await sendLineNotification(`✅ ปิดคิวของ ${queue.displayName} (ลำดับที่ ${queue.queueNumber}) แล้ว`);

    res.json({ success: true });
  } catch (error) {
    console.error('Complete Queue Error:', error);
    res.status(500).json({ error: 'Failed to complete queue' });
  }
});

// ============ GET SLIP IMAGE ============
app.get('/api/slip/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(uploadDir, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.sendFile(filepath);
  } catch (error) {
    console.error('Get Slip Error:', error);
    res.status(500).json({ error: 'Failed to get slip' });
  }
});

// ============ SERVE UPLOADS ============
app.use('/uploads', express.static(uploadDir));

// ============ LINE NOTIFICATION FUNCTIONS ============
async function sendLineNotification(message) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/broadcast', {
      messages: [
        {
          type: 'text',
          text: message
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${LINE_MESSAGING_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Send Notification Error:', error);
  }
}

async function sendLineNotificationToUser(userId, message) {
  try {
    // This requires Push API - you need to have the user's LINE ID
    // For now, we'll use broadcast which sends to all followers
    await sendLineNotification(message);
  } catch (error) {
    console.error('Send User Notification Error:', error);
  }
}

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Queue Booking Server running on port ${PORT}`);
  console.log(`📍 API Base URL: http://localhost:${PORT}`);
});

module.exports = app;
