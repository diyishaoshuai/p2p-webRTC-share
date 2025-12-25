# P2P WebRTC 屏幕共享系统

基于 WebRTC 技术的 P2P 高清屏幕共享系统，支持最高 **4K@60fps** 的屏幕共享和音频传输。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0-brightgreen)](https://nodejs.org/)

## ✨ 特性

### 核心功能
- 🎥 **高清屏幕共享**：支持 1080p、2K、4K 分辨率
- 🎬 **高帧率**：支持 30fps 和 60fps
- 🔊 **音频传输**：支持系统音频共享
- 🌐 **P2P 连接**：点对点传输，低延迟
- 🔒 **安全可靠**：动态 TURN 凭证，24小时有效期

### 用户体验
- 📱 **响应式设计**：支持桌面和移动端
- 🎮 **视频控制**：全屏、网页全屏、音量调节、静音
- 🎯 **智能控件**：鼠标停止3秒自动隐藏
- 📊 **实时状态**：显示连接状态和视频参数

### 服务器优化
- 💾 **资源保护**：内存监控、连接数限制
- 🔄 **自动清理**：空房间30分钟自动清理
- 💓 **心跳机制**：自动检测和清理僵尸连接
- 📈 **健康检查**：提供 /health 接口监控服务状态

## 🚀 快速开始

### 环境要求

- Node.js >= 14.0
- pnpm >= 8.0
- 服务器：最低 2核2GB（推荐 2核4GB）
- 浏览器：Chrome/Edge/Firefox 最新版

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/diyishaoshuai/p2p-webRTC-share.git
cd p2p-webRTC-share

# 安装依赖
pnpm install

# 启动开发服务器
pnpm start
```

服务器将在 `http://localhost:8888` 启动。

## 🎯 使用方法

### 基本使用

1. **共享端**：
   - 打开网站
   - 输入房间号，点击"加入房间"
   - 选择分辨率（1080p/2K/4K）和帧率（30fps/60fps）
   - 点击"开始共享屏幕"
   - 选择要共享的屏幕/窗口
   - 勾选"共享音频"（如需传输系统声音）

2. **观看端**：
   - 打开网站
   - 输入相同的房间号，点击"加入房间"
   - 等待共享端开始共享
   - 自动接收并显示远程屏幕

### 视频控制

- **全屏**：点击 🖥️ 按钮进入浏览器全屏
- **网页全屏**：点击 ⛶ 按钮进入网页全屏
- **静音**：点击 🔊 按钮切换静音
- **音量调节**：拖动音量滑块调整音量
- **自动隐藏**：鼠标停止移动3秒后控件自动隐藏

## 📦 部署指南

### 1. 服务器部署

```bash
# 上传代码到服务器
scp -r ./* root@your-server:/var/www/webrtc-share/

# SSH 登录服务器
ssh root@your-server

# 安装依赖
cd /var/www/webrtc-share
pnpm install --prod

# 使用 PM2 启动
pm2 start server.js --name webrtc-share
pm2 save
pm2 startup
```

### 2. Nginx 反向代理配置

创建配置文件 `/etc/nginx/conf.d/webrtc-share.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        # 基本代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

重启 Nginx：
```bash
nginx -t
systemctl reload nginx
```

### 3. SSL 证书配置

```bash
# 使用 Let's Encrypt 获取免费证书
certbot --nginx -d your-domain.com --non-interactive --agree-tos --email your-email@example.com
```

### 4. TURN 服务器配置（推荐）

安装 coturn：
```bash
yum install -y coturn  # CentOS/RHEL
# 或
apt install -y coturn  # Ubuntu/Debian
```

配置 `/etc/coturn/turnserver.conf`：
```conf
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_SERVER_IP

use-auth-secret
static-auth-secret=YOUR_SECRET_KEY

realm=your-domain.com
syslog
fingerprint
lt-cred-mech

no-loopback-peers
no-multicast-peers

min-port=49152
max-port=65535

max-bps=5000000
total-quota=100
user-quota=5
```

启动服务：
```bash
systemctl enable coturn
systemctl start coturn

# 开放防火墙端口
firewall-cmd --permanent --add-port=3478/tcp
firewall-cmd --permanent --add-port=3478/udp
firewall-cmd --permanent --add-port=5349/tcp
firewall-cmd --permanent --add-port=49152-65535/udp
firewall-cmd --reload
```

## 🔧 配置说明

### 服务器配置

编辑 `server.js` 中的配置：

```javascript
// TURN 服务器配置
const TURN_SECRET = 'your-secret-key';
const TURN_SERVER = 'your-server-ip:3478';
const TURN_TTL = 24 * 3600; // 24小时

// 资源限制
const MAX_ROOMS = 10; // 最大房间数
const MAX_USERS_PER_ROOM = 2; // 每房间最多2人
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30分钟
const CONNECTION_TIMEOUT = 10 * 60 * 1000; // 10分钟
```

## 📊 API 接口

### 获取 ICE 服务器配置
```
GET /api/ice-servers
```

### 健康检查
```
GET /health
```

## 🏗️ 技术架构

### 前端
- 原生 JavaScript
- WebRTC API
- WebSocket

### 后端
- Node.js + Express
- WebSocket (ws)
- crypto (HMAC-SHA1)

## 🔒 安全特性

- 动态 TURN 凭证（24小时有效）
- 连接数限制
- 内存监控
- 心跳机制
- 房间隔离

## 🐛 故障排查

### 无法连接
1. 检查防火墙端口
2. 检查 TURN 服务器状态
3. 查看浏览器控制台
4. 检查服务器日志：`pm2 logs webrtc-share`

### 画面卡顿
1. 降低分辨率或帧率
2. 检查网络带宽
3. 检查服务器资源

## 📝 开发计划

- [ ] 多人观看支持
- [ ] 录制功能
- [ ] 文字聊天
- [ ] 文件传输
- [ ] 连接质量显示

## 📄 许可证

MIT License

## 👨‍💻 作者

diyishaoshuai

---

⭐ 如果这个项目对你有帮助，请给个 Star！
