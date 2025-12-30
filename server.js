const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// TURN服务器配置
const TURN_SECRET = 'afdd233930fb274a47ee7aab07d19776a570815fbddcb2b8d749e50810e4ae9c';
const TURN_SERVER = '120.26.41.79:3478';
const TURN_TTL = 24 * 3600; // 24小时有效期

// 资源限制配置
const MAX_ROOMS = 10; // 最大房间数
const MAX_USERS_PER_ROOM = 2; // 每个房间最多2人
const ROOM_TIMEOUT = 30 * 60 * 1000; // 空房间30分钟超时
const CONNECTION_TIMEOUT = 10 * 60 * 1000; // 无活动连接10分钟超时

// 静态文件服务
app.use(express.static('public'));

// 生成动态TURN凭证
function generateTurnCredentials() {
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${timestamp}:webrtc`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  return {
    username: username,
    credential: credential,
    ttl: TURN_TTL
  };
}

// API: 获取ICE服务器配置
app.get('/api/ice-servers', (req, res) => {
  res.json({
    iceServers: [
      // 使用阿里云STUN服务器（国内可访问）
      { urls: 'stun:stun.miwifi.com' },
      { urls: 'stun:stun.chat.bilibili.com' },
      // 自建TURN服务器
      {
        urls: 'turn:120.26.41.79:3478',
        username: 'webrtc',
        credential: 'webrtc123456'
      },
      {
        urls: 'turn:120.26.41.79:3478?transport=tcp',
        username: 'webrtc',
        credential: 'webrtc123456'
      }
    ]
  });
});

// 健康检查接口
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const MAX_MEMORY_MB = 500;

  res.json({
    status: 'ok',
    rooms: rooms.size,
    memory: {
      used: memUsedMB,
      limit: MAX_MEMORY_MB,
      percentage: Math.round((memUsedMB / MAX_MEMORY_MB) * 100)
    },
    uptime: Math.floor(process.uptime())
  });
});

// 启动HTTP服务器
const server = app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});

// WebSocket信令服务器
const wss = new WebSocket.Server({ server });

// 存储房间和用户信息
const rooms = new Map();
const roomTimers = new Map(); // 房间超时定时器

// 内存监控
function checkMemoryUsage() {
  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);

  // 2GB服务器，Node.js进程使用超过500MB就认为资源紧张
  const MAX_MEMORY_MB = 500;

  if (memUsedMB > MAX_MEMORY_MB) {
    console.warn(`⚠️ 内存使用过高: ${memUsedMB}MB (限制: ${MAX_MEMORY_MB}MB)`);
    return false;
  }
  return true;
}

// 清理空房间
function cleanupEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.size === 0) {
    rooms.delete(roomId);
    if (roomTimers.has(roomId)) {
      clearTimeout(roomTimers.get(roomId));
      roomTimers.delete(roomId);
    }
    console.log(`🧹 清理空房间: ${roomId}`);
  }
}

wss.on('connection', (ws) => {
  console.log('新客户端连接');

  // 设置连接超时定时器
  ws.isAlive = true;
  ws.lastActivity = Date.now();

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
  });

  ws.on('message', (message) => {
    try {
      ws.lastActivity = Date.now(); // 更新活动时间
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('消息解析错误:', error);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleMessage(ws, data) {
  const { type, roomId, userId } = data;

  switch (type) {
    case 'ping':
      // 响应心跳
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      break;
    case 'join':
      handleJoin(ws, roomId, userId);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      forwardToRoom(ws, roomId, data);
      break;
    default:
      console.log('未知消息类型:', type);
  }
}

function handleJoin(ws, roomId, userId) {
  // 检查内存使用率
  if (!checkMemoryUsage()) {
    ws.send(JSON.stringify({
      type: 'error',
      message: '服务器资源不足，请稍后再试'
    }));
    ws.close();
    return;
  }

  // 检查房间数量限制
  if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
    ws.send(JSON.stringify({
      type: 'error',
      message: '服务器繁忙，房间数已达上限'
    }));
    ws.close();
    return;
  }

  ws.roomId = roomId;
  ws.userId = userId;

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);

  // 检查房间人数限制
  if (room.size >= MAX_USERS_PER_ROOM) {
    ws.send(JSON.stringify({
      type: 'error',
      message: '房间已满，最多支持2人'
    }));
    ws.close();
    return;
  }

  // 清除房间超时定时器
  if (roomTimers.has(roomId)) {
    clearTimeout(roomTimers.get(roomId));
    roomTimers.delete(roomId);
  }

  // 通知房间内其他用户
  room.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'user-joined',
        userId: userId
      }));
    }
  });

  room.add(ws);

  console.log(`用户 ${userId} 加入房间 ${roomId} (当前房间数: ${rooms.size}, 房间人数: ${room.size})`);

  // 发送当前房间用户列表
  const users = Array.from(room).map(client => client.userId);
  ws.send(JSON.stringify({
    type: 'room-users',
    users: users.filter(id => id !== userId)
  }));
}

function forwardToRoom(ws, roomId, data) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.forEach(client => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function handleDisconnect(ws) {
  if (ws.roomId && ws.userId) {
    const room = rooms.get(ws.roomId);
    if (room) {
      room.delete(ws);

      // 通知其他用户
      room.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'user-left',
            userId: ws.userId
          }));
        }
      });

      console.log(`用户 ${ws.userId} 离开房间 ${ws.roomId} (剩余人数: ${room.size})`);

      // 如果房间为空，设置30分钟后清理
      if (room.size === 0) {
        const timer = setTimeout(() => {
          cleanupEmptyRoom(ws.roomId);
        }, ROOM_TIMEOUT);
        roomTimers.set(ws.roomId, timer);
        console.log(`⏰ 房间 ${ws.roomId} 将在30分钟后清理`);
      }
    }
  }
}

// 心跳检测 - 每30秒检查一次
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`💔 连接超时，断开连接: ${ws.userId || 'unknown'}`);
      return ws.terminate();
    }

    // 检查无活动连接
    const inactiveTime = Date.now() - ws.lastActivity;
    if (inactiveTime > CONNECTION_TIMEOUT) {
      console.log(`⏱️ 连接无活动超时，断开连接: ${ws.userId || 'unknown'}`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 清理定时器
wss.on('close', () => {
  clearInterval(heartbeatInterval);
});
