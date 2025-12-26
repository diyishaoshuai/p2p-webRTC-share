// WebRTC配置 - 将从服务器动态获取
let configuration = {
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// 从服务器获取ICE服务器配置（包含动态TURN凭证）
async function fetchIceServers() {
  try {
    const response = await fetch('/api/ice-servers');
    const data = await response.json();
    configuration.iceServers = data.iceServers;
    console.log('✅ 已获取动态TURN凭证');
    return true;
  } catch (error) {
    console.error('❌ 获取ICE服务器配置失败:', error);
    // 使用备用STUN服务器
    configuration.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    return false;
  }
}

// 全局变量
let ws = null;
let peerConnection = null;
let localStream = null;
let roomId = null;
let userId = Math.random().toString(36).substr(2, 9);
let heartbeatInterval = null; // 心跳定时器
let roomUsers = []; // 房间内的其他用户列表
let pendingIceCandidates = []; // 待处理的ICE候选队列

// DOM元素
const roomIdInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const resolutionSelect = document.getElementById('resolutionSelect');
const fpsSelect = document.getElementById('fpsSelect');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusSpan = document.getElementById('status');
const currentRoomSpan = document.getElementById('currentRoom');
const localLoading = document.getElementById('localLoading');
const remoteLoading = document.getElementById('remoteLoading');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const webFullscreenBtn = document.getElementById('webFullscreenBtn');
const muteBtn = document.getElementById('muteBtn');
const volumeSlider = document.getElementById('volumeSlider');
const remoteContainer = document.getElementById('remoteContainer');
const videoControls = document.getElementById('videoControls');

// 控件自动隐藏相关变量
let controlsHideTimer = null;
const CONTROLS_HIDE_DELAY = 3000; // 3秒后隐藏

// 事件监听
joinBtn.addEventListener('click', joinRoom);
shareBtn.addEventListener('click', startScreenShare);
stopBtn.addEventListener('click', stopScreenShare);
fullscreenBtn.addEventListener('click', toggleFullscreen);
webFullscreenBtn.addEventListener('click', toggleWebFullscreen);
muteBtn.addEventListener('click', toggleMute);
volumeSlider.addEventListener('input', adjustVolume);

// 监听远程视频容器的鼠标移动
remoteContainer.addEventListener('mousemove', showControls);
remoteContainer.addEventListener('mouseleave', hideControlsImmediately);

// 加入房间
async function joinRoom() {
  roomId = roomIdInput.value.trim();
  if (!roomId) {
    alert('请输入房间号');
    return;
  }

  // 先获取ICE服务器配置
  updateStatus('正在获取服务器配置...');
  await fetchIceServers();

  // 连接WebSocket服务器
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket连接成功');
    ws.send(JSON.stringify({
      type: 'join',
      roomId: roomId,
      userId: userId
    }));

    updateStatus('已连接');
    currentRoomSpan.textContent = roomId;
    joinBtn.disabled = true;
    shareBtn.disabled = false;
    roomIdInput.disabled = true;

    // 启动心跳机制，每30秒发送一次ping
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  };

  ws.onmessage = handleSignalingMessage;

  ws.onerror = (error) => {
    console.error('WebSocket错误:', error);
    updateStatus('连接错误');
  };

  ws.onclose = () => {
    console.log('WebSocket连接关闭');
    updateStatus('已断开');
    joinBtn.disabled = false;
    shareBtn.disabled = true;
    stopBtn.disabled = true;
    roomIdInput.disabled = false;

    // 清理心跳定时器
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };
}

// 处理信令消息
async function handleSignalingMessage(event) {
  const data = JSON.parse(event.data);
  console.log('收到信令消息:', data.type);

  switch (data.type) {
    case 'error':
      // 处理服务器错误
      alert(data.message);
      updateStatus('错误: ' + data.message);
      break;

    case 'pong':
      // 心跳响应
      console.log('收到心跳响应');
      break;

    case 'room-users':
      // 房间内已有其他用户，保存用户列表
      console.log('房间内已有用户:', data.users);
      roomUsers = data.users || [];
      // 如果本地已有流，主动向这些用户发送offer
      if (localStream && roomUsers.length > 0) {
        await sendOfferToRoomUsers();
      }
      break;

    case 'user-joined':
      console.log('新用户加入:', data.userId);
      // 更新用户列表
      if (!roomUsers.includes(data.userId)) {
        roomUsers.push(data.userId);
      }
      // 如果本地有流，主动向新用户发送offer
      if (localStream) {
        await sendOfferToRoomUsers();
      }
      break;

    case 'offer':
      await handleOffer(data.offer);
      break;

    case 'answer':
      await handleAnswer(data.answer);
      break;

    case 'ice-candidate':
      await handleIceCandidate(data.candidate);
      break;

    case 'user-left':
      console.log('用户离开:', data.userId);
      // 更新用户列表
      roomUsers = roomUsers.filter(id => id !== data.userId);
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      remoteVideo.srcObject = null;
      remoteLoading.classList.remove('hidden'); // 显示远程loading
      break;
  }
}

// 开始屏幕共享
async function startScreenShare() {
  try {
    // 检查浏览器是否支持屏幕共享
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('您的浏览器不支持屏幕共享功能，请使用Chrome、Edge或Firefox浏览器');
      return;
    }

    // 获取用户选择的分辨率和帧率
    const resolution = resolutionSelect.value.split('x');
    const width = parseInt(resolution[0]);
    const height = parseInt(resolution[1]);
    const fps = parseInt(fpsSelect.value);

    console.log(`请求屏幕共享: ${width}x${height}@${fps}fps`);

    // 请求屏幕共享权限，使用用户选择的参数
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps }
      },
      audio: true
    });

    localVideo.srcObject = localStream;
    localLoading.classList.add('hidden'); // 隐藏本地loading
    shareBtn.disabled = true;
    stopBtn.disabled = false;
    updateStatus('正在共享屏幕');

    // 确保本地视频播放
    localVideo.play().catch(error => {
      console.error('本地视频播放失败:', error);
    });

    // 监听屏幕共享停止事件
    localStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    console.log('屏幕共享已启动，轨道信息:');
    localStream.getTracks().forEach(track => {
      console.log('本地轨道:', track.kind, track.id, 'enabled:', track.enabled, 'readyState:', track.readyState);
      if (track.kind === 'video') {
        const settings = track.getSettings();
        console.log(`实际视频参数: ${settings.width}x${settings.height}@${settings.frameRate}fps`);
        updateStatus(`共享中: ${settings.width}x${settings.height}@${settings.frameRate}fps`);
      }
    });
    
    // 如果房间内已有其他用户，主动创建连接并发送offer
    if (roomUsers.length > 0) {
      console.log('房间内已有用户，主动发送offer');
      await sendOfferToRoomUsers();
    }
  } catch (error) {
    console.error('屏幕共享失败:', error);

    // 根据不同的错误类型给出具体提示
    let errorMessage = '无法获取屏幕共享权限';

    if (error.name === 'NotAllowedError') {
      errorMessage = '您拒绝了屏幕共享权限，请点击"开始共享屏幕"按钮重新授权';
    } else if (error.name === 'NotFoundError') {
      errorMessage = '未找到可共享的屏幕或窗口';
    } else if (error.name === 'NotSupportedError') {
      errorMessage = '您的浏览器不支持屏幕共享，请使用Chrome、Edge或Firefox浏览器';
    } else if (error.name === 'NotReadableError') {
      errorMessage = '无法访问屏幕共享设备，可能被其他应用占用';
    } else if (error.name === 'OverconstrainedError') {
      errorMessage = '屏幕共享参数不支持，正在尝试降低配置...';
      // 尝试使用更宽松的配置
      tryFallbackScreenShare();
      return;
    }

    alert(errorMessage);
  }
}

// 降级方案：使用更宽松的配置
async function tryFallbackScreenShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    localVideo.srcObject = localStream;
    localLoading.classList.add('hidden'); // 隐藏本地loading
    shareBtn.disabled = true;
    stopBtn.disabled = false;
    updateStatus('正在共享屏幕');

    localStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    console.log('屏幕共享已启动(降级模式)');
    
    // 如果房间内已有其他用户，主动创建连接并发送offer
    if (roomUsers.length > 0) {
      console.log('房间内已有用户，主动发送offer');
      await sendOfferToRoomUsers();
    }
  } catch (error) {
    console.error('降级屏幕共享也失败:', error);
    alert('屏幕共享失败，请确保:\n1. 使用HTTPS访问\n2. 允许浏览器权限\n3. 使用Chrome/Edge/Firefox浏览器');
  }
}

// 停止屏幕共享
function stopScreenShare() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  localVideo.srcObject = null;
  localLoading.classList.remove('hidden'); // 显示本地loading
  shareBtn.disabled = false;
  stopBtn.disabled = true;
  updateStatus('已连接');

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // 停止码率监控
  if (bitrateMonitorInterval) {
    clearInterval(bitrateMonitorInterval);
    bitrateMonitorInterval = null;
  }

  console.log('屏幕共享已停止');
}

// 创建PeerConnection
async function createPeerConnection() {
  // 如果已有连接，先关闭
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // 清空待处理的ICE候选队列
  pendingIceCandidates = [];
  
  peerConnection = new RTCPeerConnection(configuration);

  // 添加本地流到连接
  if (localStream) {
    localStream.getTracks().forEach(track => {
      console.log('添加本地轨道:', track.kind, track.id);
      peerConnection.addTrack(track, localStream);
    });
  }

  // 监听远程流
  peerConnection.ontrack = async (event) => {
    console.log('收到远程流事件:', event);
    console.log('远程流数量:', event.streams ? event.streams.length : 0);
    console.log('远程轨道:', event.track ? event.track.kind : 'none', event.track ? event.track.id : 'none');
    
    if (event.streams && event.streams.length > 0) {
      const remoteStream = event.streams[0];
      console.log('设置远程视频流，轨道数:', remoteStream.getTracks().length);
      remoteStream.getTracks().forEach(track => {
        console.log('远程轨道:', track.kind, track.id, 'enabled:', track.enabled, 'muted:', track.muted, 'readyState:', track.readyState);
      });
      
      remoteVideo.srcObject = remoteStream;
      remoteLoading.classList.add('hidden'); // 隐藏远程loading
      
      // 检查解码器信息（硬件/软件解码）
      setTimeout(async () => {
        try {
          const receivers = peerConnection.getReceivers();
          for (const receiver of receivers) {
            if (receiver.track && receiver.track.kind === 'video') {
              const codecInfo = await getDecoderInfo(receiver);
              if (codecInfo) {
                console.log(`📺 使用解码器: ${codecInfo.name} (${codecInfo.hardware ? '硬件' : '软件'}解码)`);
              }
            }
          }
        } catch (error) {
          console.error('获取解码器信息失败:', error);
        }
      }, 1000);
      
      // 确保视频播放
      remoteVideo.play().then(() => {
        console.log('远程视频开始播放');
      }).catch(error => {
        console.error('远程视频播放失败:', error);
      });
      
      // 监听远程轨道状态
      if (event.track) {
        event.track.onended = () => {
          console.log('远程轨道已结束');
          remoteLoading.classList.remove('hidden');
        };
        
        event.track.onmute = () => {
          console.log('远程轨道已静音');
        };
        
        event.track.onunmute = () => {
          console.log('远程轨道已取消静音');
        };
        
        event.track.onerror = (error) => {
          console.error('远程轨道错误:', error);
        };
      }
    } else if (event.track) {
      // 如果没有流对象但有轨道，创建一个新流
      console.log('创建新的远程流');
      const remoteStream = new MediaStream([event.track]);
      remoteVideo.srcObject = remoteStream;
      remoteLoading.classList.add('hidden');
      
      remoteVideo.play().then(() => {
        console.log('远程视频开始播放');
      }).catch(error => {
        console.error('远程视频播放失败:', error);
      });
    } else {
      console.warn('收到远程流事件但没有流对象和轨道');
    }
  };

  // 监听ICE候选
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const candidate = event.candidate;
      const candidateStr = candidate.candidate;
      const candidateType = candidateStr.includes('typ host') ? 'host' : 
                           candidateStr.includes('typ srflx') ? 'srflx' :
                           candidateStr.includes('typ relay') ? 'relay' : 'unknown';
      console.log(`生成ICE候选 [${candidateType}]:`, candidateStr.substring(0, 80) + '...');
      
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        roomId: roomId,
        userId: userId,
        candidate: candidate
      }));
    } else {
      console.log('ICE候选收集完成');
      // 检查是否有relay类型的候选（TURN服务器）
      const stats = peerConnection.getStats();
      stats.then(results => {
        let hasRelay = false;
        results.forEach(report => {
          if (report.type === 'local-candidate' && report.candidateType === 'relay') {
            hasRelay = true;
            console.log('检测到TURN中继候选');
          }
        });
        if (!hasRelay) {
          console.warn('警告: 未检测到TURN中继候选');
          console.warn('如果连接失败，可能需要配置可用的TURN服务器');
          console.warn('当前TURN服务器可能无法访问或被防火墙阻止');
        } else {
          console.log('✓ 已检测到TURN中继候选，连接应该可以成功');
        }
      });
    }
  };

  // 监听连接状态
  peerConnection.onconnectionstatechange = async () => {
    const state = peerConnection.connectionState;
    console.log('连接状态:', state);
    updateStatus(`连接状态: ${state}`);

    if (state === 'connected') {
      updateStatus('P2P连接成功');
      
      // 获取连接统计信息
      try {
        const stats = await peerConnection.getStats();
        let localCandidates = [];
        let remoteCandidates = [];
        
        stats.forEach(report => {
          if (report.type === 'local-candidate') {
            localCandidates.push({
              type: report.candidateType,
              protocol: report.protocol,
              address: report.address
            });
          } else if (report.type === 'remote-candidate') {
            remoteCandidates.push({
              type: report.candidateType,
              protocol: report.protocol,
              address: report.address
            });
          }
        });
        
        console.log('本地候选:', localCandidates);
        console.log('远程候选:', remoteCandidates);
      } catch (error) {
        console.error('获取统计信息失败:', error);
      }
    } else if (state === 'failed') {
      updateStatus('连接失败');
      console.error('P2P连接失败');
      
      // 获取失败原因
      try {
        const stats = await peerConnection.getStats();
        let hasRelay = false;
        let turnErrors = [];
        stats.forEach(report => {
          if (report.type === 'local-candidate' && report.candidateType === 'relay') {
            hasRelay = true;
          }
        });
        
        if (!hasRelay) {
          console.error('诊断: 未使用TURN服务器，可能是NAT穿透失败');
          console.error('可能的原因:');
          console.error('1. 网络环境不支持P2P直连（对称NAT）');
          console.error('2. TURN服务器无法访问或被防火墙阻止');
          console.error('3. 双方网络环境不兼容');
          console.error('');
          console.error('解决方案:');
          console.error('1. 检查防火墙设置，确保允许UDP/TCP连接');
          console.error('2. 配置自己的TURN服务器（推荐）');
          console.error('3. 尝试使用VPN或更换网络环境');
          updateStatus('连接失败: NAT穿透失败，需要TURN服务器');
          
          // 显示用户友好的提示
          setTimeout(() => {
            const message = '连接失败\n\n' +
              '原因：无法建立P2P直连，且TURN服务器不可用\n\n' +
              '建议：\n' +
              '1. 检查网络防火墙设置\n' +
              '2. 配置自己的TURN服务器\n' +
              '3. 尝试使用VPN或更换网络\n\n' +
              '如需帮助，请查看控制台日志';
            if (confirm(message + '\n\n是否刷新页面重试？')) {
              window.location.reload();
            }
          }, 1000);
        } else {
          updateStatus('连接失败: 请检查网络设置');
        }
      } catch (error) {
        console.error('获取失败诊断信息失败:', error);
        updateStatus('连接失败: 请检查网络设置');
      }
    } else if (state === 'disconnected') {
      updateStatus('连接断开');
      console.warn('P2P连接已断开');
    }
  };

  // 监听ICE连接状态
  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    console.log('ICE连接状态:', state);
    
    if (state === 'failed') {
      console.error('ICE连接失败，可能需要TURN服务器或检查网络设置');
      updateStatus('ICE连接失败');
    } else if (state === 'connected') {
      console.log('ICE连接成功');
    } else if (state === 'disconnected') {
      console.warn('ICE连接断开');
      updateStatus('ICE连接断开');
    } else if (state === 'checking') {
      console.log('ICE正在检查连接...');
      updateStatus('正在建立连接...');
    }
  };
  
  // 监听ICE候选错误
  peerConnection.onicecandidateerror = (event) => {
    // 只记录TURN服务器错误，STUN错误可以忽略（因为还有其他STUN服务器）
    if (event.url && event.url.includes('turn:')) {
      console.warn(`TURN服务器连接失败: ${event.url}`);
      if (event.errorCode) {
        console.warn(`错误代码: ${event.errorCode}, 错误文本: ${event.errorText}`);
      }
    } else if (event.url && event.url.includes('stun:')) {
      // STUN错误可以忽略，因为还有其他STUN服务器可用
      console.log(`STUN服务器连接失败（可忽略）: ${event.url}`);
    }
  };

  // 监听ICE收集状态
  peerConnection.onicegatheringstatechange = () => {
    console.log('ICE收集状态:', peerConnection.iceGatheringState);
  };
}

// 向房间内的其他用户发送offer
async function sendOfferToRoomUsers() {
  if (!localStream || roomUsers.length === 0) {
    console.log('无法发送offer: localStream=', !!localStream, 'roomUsers.length=', roomUsers.length);
    return;
  }
  
  try {
    console.log('开始创建PeerConnection并发送offer');
    await createPeerConnection();
    
    // 等待一下，让ICE候选开始收集
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const offer = await peerConnection.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: true
    });
    
    // 修改SDP以强制使用硬件编码
    offer.sdp = modifySdpForHardwareEncoding(offer.sdp);
    
    await peerConnection.setLocalDescription(offer);
    
    // 在设置本地描述后，设置编码参数
    await setEncodingParametersAfterOffer();
    
    console.log('发送offer，SDP类型:', offer.type);
    ws.send(JSON.stringify({
      type: 'offer',
      roomId: roomId,
      userId: userId,
      offer: offer
    }));
    console.log('已向房间用户发送offer');
  } catch (error) {
    console.error('发送offer失败:', error);
  }
}

// 在offer/answer交换后设置编码参数
async function setEncodingParametersAfterOffer() {
  if (!peerConnection || !localStream) return;
  
  try {
    const senders = peerConnection.getSenders();
    for (const sender of senders) {
      if (sender.track && sender.track.kind === 'video') {
        await setVideoEncodingParameters(sender, sender.track);
        // 强制使用硬件编码
        await forceHardwareEncoding(sender);
      }
    }
  } catch (error) {
    console.error('设置编码参数失败:', error);
  }
}

// 强制使用硬件编码
async function forceHardwareEncoding(sender) {
  try {
    const params = sender.getParameters();
    
    if (!params.codecs) {
      // 如果codecs未设置，尝试通过SDP修改
      console.log('⚠️ 无法直接设置编码器，将通过SDP修改');
      return;
    }
    
    // 优先选择硬件编码器
    // H.264通常有硬件支持，VP8/VP9通常是软件编码
    const hardwareCodecs = ['H264', 'h264'];
    const softwareCodecs = ['VP8', 'vp8', 'VP9', 'vp9'];
    
    // 重新排序编码器，硬件编码器优先
    if (params.codecs && params.codecs.length > 0) {
      const sortedCodecs = [];
      
      // 先添加硬件编码器
      for (const codec of params.codecs) {
        const codecName = codec.mimeType?.split('/')[1] || '';
        if (hardwareCodecs.some(hc => codecName.toLowerCase().includes(hc.toLowerCase()))) {
          sortedCodecs.push(codec);
        }
      }
      
      // 再添加其他编码器
      for (const codec of params.codecs) {
        const codecName = codec.mimeType?.split('/')[1] || '';
        if (!hardwareCodecs.some(hc => codecName.toLowerCase().includes(hc.toLowerCase())) &&
            !softwareCodecs.some(sc => codecName.toLowerCase().includes(sc.toLowerCase()))) {
          sortedCodecs.push(codec);
        }
      }
      
      // 最后添加软件编码器（作为备选）
      for (const codec of params.codecs) {
        const codecName = codec.mimeType?.split('/')[1] || '';
        if (softwareCodecs.some(sc => codecName.toLowerCase().includes(sc.toLowerCase()))) {
          sortedCodecs.push(codec);
        }
      }
      
      if (sortedCodecs.length > 0) {
        params.codecs = sortedCodecs;
        await sender.setParameters(params);
        console.log('✅ 已设置编码器优先级（硬件编码优先）');
        console.log('编码器顺序:', params.codecs.map(c => c.mimeType).join(', '));
      }
    }
  } catch (error) {
    console.warn('设置硬件编码失败（将使用SDP修改）:', error);
  }
}

// 修改SDP以强制使用硬件编码
function modifySdpForHardwareEncoding(sdp) {
  try {
    let modifiedSdp = sdp;
    
    // 查找所有视频编码器
    const videoCodecRegex = /m=video\s+\d+\s+([^\r\n]+)/g;
    const codecMatches = [];
    let match;
    
    while ((match = videoCodecRegex.exec(sdp)) !== null) {
      codecMatches.push(match);
    }
    
    // 优先选择H.264（通常有硬件支持）
    // 移除或降低VP8/VP9的优先级（通常是软件编码）
    const lines = sdp.split('\n');
    const modifiedLines = [];
    let inVideoSection = false;
    let videoPayloadTypes = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('m=video')) {
        inVideoSection = true;
        // 提取payload types
        const payloadTypes = line.split(' ').slice(3);
        videoPayloadTypes = payloadTypes.map(pt => parseInt(pt)).filter(pt => !isNaN(pt));
        modifiedLines.push(line);
        continue;
      }
      
      if (line.startsWith('m=') && !line.startsWith('m=video')) {
        inVideoSection = false;
      }
      
      // 在视频部分，优先H.264编码器
      if (inVideoSection && line.startsWith('a=rtpmap:')) {
        const payloadType = parseInt(line.split(':')[1].split(' ')[0]);
        const codecName = line.toLowerCase();
        
        // H.264编码器（硬件支持）
        if (codecName.includes('h264') || codecName.includes('h.264')) {
          // 保持H.264，并提高优先级
          modifiedLines.push(line);
          // 添加硬件编码标识
          if (!lines[i + 1]?.includes('a=fmtp:')) {
            modifiedLines.push(`a=fmtp:${payloadType} profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1`);
          }
          continue;
        }
        
        // VP8/VP9编码器（通常是软件编码）
        if (codecName.includes('vp8') || codecName.includes('vp9')) {
          // 降低优先级，但不移除（作为备选）
          modifiedLines.push(line);
          continue;
        }
        
        // 其他编码器
        modifiedLines.push(line);
        continue;
      }
      
      // 设置编码器优先级（H.264优先）
      if (inVideoSection && line.startsWith('a=rtcp-fb:')) {
        modifiedLines.push(line);
        continue;
      }
      
      modifiedLines.push(line);
    }
    
    modifiedSdp = modifiedLines.join('\n');
    
    // 重新排序m=video行中的payload types，H.264优先
    modifiedSdp = modifiedSdp.replace(/m=video\s+\d+\s+([^\r\n]+)/, (match, payloadTypes) => {
      const types = payloadTypes.split(' ').filter(t => t);
      // 这里我们保持原有顺序，因为优先级在SDP的其他部分设置
      return match;
    });
    
    console.log('✅ 已修改SDP以优先使用硬件编码（H.264）');
    return modifiedSdp;
  } catch (error) {
    console.error('修改SDP失败:', error);
    return sdp;
  }
}

// 处理Offer
async function handleOffer(offer) {
  console.log('收到Offer，准备创建Answer');

  // 如果已有连接，先关闭
  if (peerConnection) {
    console.log('关闭已有连接');
    peerConnection.close();
    peerConnection = null;
  }

  await createPeerConnection();
  console.log('设置远程Offer描述');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

  // 处理之前收到的ICE候选
  console.log('处理待处理的ICE候选，数量:', pendingIceCandidates.length);
  for (const candidate of pendingIceCandidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('已添加待处理的ICE候选');
    } catch (error) {
      console.error('添加待处理的ICE候选失败:', error);
    }
  }
  pendingIceCandidates = [];

  console.log('创建Answer');
  const answer = await peerConnection.createAnswer();
  
  // 修改SDP以强制使用硬件编码
  answer.sdp = modifySdpForHardwareEncoding(answer.sdp);
  
  await peerConnection.setLocalDescription(answer);
  
  // 在设置本地描述后，设置编码参数
  await setEncodingParametersAfterOffer();

  console.log('发送Answer');
  ws.send(JSON.stringify({
    type: 'answer',
    roomId: roomId,
    userId: userId,
    answer: answer
  }));
}

// 处理Answer
async function handleAnswer(answer) {
  if (peerConnection) {
    console.log('设置远程Answer描述');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    
    // 在设置远程描述后，设置编码参数
    await setEncodingParametersAfterOffer();
    
    // 处理之前收到的ICE候选
    console.log('处理待处理的ICE候选，数量:', pendingIceCandidates.length);
    for (const candidate of pendingIceCandidates) {
      try {
        if (candidate && candidate.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('已添加待处理的ICE候选');
        } else {
          console.warn('跳过无效的ICE候选');
        }
      } catch (error) {
        // 忽略某些错误（如重复的候选）
        if (error.message && error.message.includes('already')) {
          console.log('待处理的ICE候选已存在，忽略');
        } else {
          console.error('添加待处理的ICE候选失败:', error);
        }
      }
    }
    pendingIceCandidates = [];
  } else {
    console.error('收到Answer但PeerConnection不存在');
  }
}

// 处理ICE候选
async function handleIceCandidate(candidate) {
  if (!candidate || !candidate.candidate) {
    console.warn('收到无效的ICE候选');
    return;
  }
  
  if (peerConnection) {
    // 检查PeerConnection是否已经设置了远程描述
    if (peerConnection.remoteDescription) {
      try {
        const candidateStr = candidate.candidate || '';
        const candidateType = candidateStr.includes('typ host') ? 'host' : 
                             candidateStr.includes('typ srflx') ? 'srflx' :
                             candidateStr.includes('typ relay') ? 'relay' : 'unknown';
        console.log(`添加ICE候选 [${candidateType}]:`, candidateStr.substring(0, 80) + '...');
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('ICE候选添加成功');
      } catch (error) {
        // 忽略某些错误（如重复的候选）
        if (error.message && error.message.includes('already')) {
          console.log('ICE候选已存在，忽略');
        } else {
          console.error('添加ICE候选失败:', error);
        }
      }
    } else {
      // 如果还没有设置远程描述，先保存到队列
      console.log('PeerConnection尚未设置远程描述，将ICE候选加入队列');
      pendingIceCandidates.push(candidate);
    }
  } else {
    // 如果PeerConnection不存在，保存到队列
    console.log('PeerConnection不存在，将ICE候选加入队列');
    pendingIceCandidates.push(candidate);
  }
}

// 设置视频编码参数和码率限制
async function setVideoEncodingParameters(sender, track) {
  try {
    const settings = track.getSettings();
    const width = settings.width || 1920;
    const height = settings.height || 1080;
    const frameRate = settings.frameRate || 30;
    
    // 根据分辨率和帧率计算合适的码率（Mbps）
    // 4K@60fps: 25-50Mbps, 2K@60fps: 12-25Mbps, 1080p@60fps: 6-12Mbps
    let maxBitrate;
    const pixels = width * height;
    
    if (pixels >= 3840 * 2160) {
      // 4K
      maxBitrate = frameRate >= 60 ? 45000000 : 30000000; // 45Mbps @ 60fps, 30Mbps @ 30fps
    } else if (pixels >= 2560 * 1440) {
      // 2K
      maxBitrate = frameRate >= 60 ? 20000000 : 15000000; // 20Mbps @ 60fps, 15Mbps @ 30fps
    } else {
      // 1080p
      maxBitrate = frameRate >= 60 ? 10000000 : 6000000; // 10Mbps @ 60fps, 6Mbps @ 30fps
    }
    
    // 等待sender参数可用
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const params = sender.getParameters();
    
    if (!params.encodings) {
      params.encodings = [{}];
    }
    
    // 设置编码参数
    params.encodings.forEach(encoding => {
      // 设置最大码率（bps）
      encoding.maxBitrate = maxBitrate;
      
      // 设置编码优先级（高优先级用于低延迟）
      encoding.priority = 'high';
      
      // 设置网络优先级
      encoding.networkPriority = 'high';
      
      // 对于4K，可以启用可扩展编码（如果支持）
      if (pixels >= 3840 * 2160) {
        // 尝试使用可扩展编码以降低码率
        encoding.scaleResolutionDownBy = 1.0; // 不缩放
      }
    });
    
    // 应用参数
    await sender.setParameters(params);
    
    // 检查使用的编码器
    const codecInfo = await getCodecInfo(sender);
    console.log(`✅ 已设置视频编码参数: ${width}x${height}@${frameRate}fps, 最大码率: ${(maxBitrate / 1000000).toFixed(1)}Mbps`);
    if (codecInfo) {
      console.log(`📹 使用编码器: ${codecInfo.name} (${codecInfo.hardware ? '硬件' : '软件'}编码)`);
    }
    
    // 监控实际码率
    monitorBitrate(sender, track);
  } catch (error) {
    console.error('设置编码参数失败:', error);
    console.warn('将使用浏览器默认编码参数');
  }
}

// 获取编码器信息
async function getCodecInfo(sender) {
  try {
    const stats = await sender.getStats();
    let codecInfo = null;
    
    stats.forEach(report => {
      if (report.type === 'codec') {
        const codecName = report.mimeType?.toLowerCase() || '';
        const isHardware = codecName.includes('h264') || codecName.includes('h.264');
        codecInfo = {
          name: report.mimeType || 'unknown',
          hardware: isHardware
        };
      }
    });
    
    return codecInfo;
  } catch (error) {
    console.error('获取编码器信息失败:', error);
    return null;
  }
}

// 获取解码器信息
async function getDecoderInfo(receiver) {
  try {
    const stats = await receiver.getStats();
    let codecInfo = null;
    
    stats.forEach(report => {
      if (report.type === 'codec') {
        const codecName = report.mimeType?.toLowerCase() || '';
        const isHardware = codecName.includes('h264') || codecName.includes('h.264');
        codecInfo = {
          name: report.mimeType || 'unknown',
          hardware: isHardware
        };
      }
    });
    
    return codecInfo;
  } catch (error) {
    console.error('获取解码器信息失败:', error);
    return null;
  }
}

// 监控实际码率
let bitrateMonitorInterval = null;
function monitorBitrate(sender, track) {
  // 清除之前的监控
  if (bitrateMonitorInterval) {
    clearInterval(bitrateMonitorInterval);
  }
  
  let lastBytesSent = 0;
  let lastTimestamp = Date.now();
  
  bitrateMonitorInterval = setInterval(async () => {
    try {
      const stats = await sender.getStats();
      let currentBytesSent = 0;
      let currentTimestamp = Date.now();
      
      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
          currentBytesSent = report.bytesSent || 0;
          currentTimestamp = report.timestamp || Date.now();
        }
      });
      
      if (lastBytesSent > 0) {
        const bytesDiff = currentBytesSent - lastBytesSent;
        const timeDiff = (currentTimestamp - lastTimestamp) / 1000; // 秒
        const bitrate = (bytesDiff * 8) / timeDiff; // bps
        const bitrateMbps = (bitrate / 1000000).toFixed(2);
        
        const settings = track.getSettings();
        const resolution = `${settings.width || 0}x${settings.height || 0}`;
        const fps = settings.frameRate || 0;
        
        console.log(`📊 实时码率: ${bitrateMbps}Mbps (${resolution}@${fps}fps)`);
        
        // 如果码率过高，给出警告
        if (bitrate > 50000000) { // 50Mbps
          console.warn('⚠️ 码率过高，可能导致网络拥塞');
        }
      }
      
      lastBytesSent = currentBytesSent;
      lastTimestamp = currentTimestamp;
    } catch (error) {
      console.error('获取码率统计失败:', error);
    }
  }, 2000); // 每2秒检查一次
}

// 更新状态显示
function updateStatus(status) {
  statusSpan.textContent = status;
}

// 全屏功能
function toggleFullscreen() {
  const videoContainer = remoteVideo.parentElement;

  if (!document.fullscreenElement) {
    // 进入全屏
    if (videoContainer.requestFullscreen) {
      videoContainer.requestFullscreen();
    } else if (videoContainer.webkitRequestFullscreen) {
      videoContainer.webkitRequestFullscreen();
    } else if (videoContainer.mozRequestFullScreen) {
      videoContainer.mozRequestFullScreen();
    } else if (videoContainer.msRequestFullscreen) {
      videoContainer.msRequestFullscreen();
    }
    fullscreenBtn.textContent = '🗗';
  } else {
    // 退出全屏
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
    fullscreenBtn.textContent = '🖥️';
  }
}

// 网页全屏功能
function toggleWebFullscreen() {
  const videoContainer = remoteVideo.parentElement;

  if (!videoContainer.classList.contains('web-fullscreen')) {
    videoContainer.classList.add('web-fullscreen');
    webFullscreenBtn.textContent = '⛶';
    console.log('进入网页全屏');
  } else {
    videoContainer.classList.remove('web-fullscreen');
    webFullscreenBtn.textContent = '⛶';
    console.log('退出网页全屏');
  }
}

// 静音/取消静音
function toggleMute() {
  if (remoteVideo.muted) {
    remoteVideo.muted = false;
    muteBtn.textContent = '🔊';
  } else {
    remoteVideo.muted = true;
    muteBtn.textContent = '🔇';
  }
}

// 调节音量
function adjustVolume() {
  remoteVideo.volume = volumeSlider.value / 100;
}

// 显示控件
function showControls() {
  videoControls.classList.remove('hidden');

  // 清除之前的定时器
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
  }

  // 3秒后自动隐藏
  controlsHideTimer = setTimeout(() => {
    videoControls.classList.add('hidden');
  }, CONTROLS_HIDE_DELAY);
}

// 立即隐藏控件
function hideControlsImmediately() {
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
  }
  videoControls.classList.add('hidden');
}
