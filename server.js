const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const activeRooms = new Map();
const userSockets = new Map();

class ChatRoom {
  constructor(topic, secret) {
    this.topic = topic;
    this.secret = secret;
    this.swarm = new Hyperswarm();
    this.peers = new Set();
    this.messages = [];
    this.socketClients = new Set();
    this.setupSwarm();
  }

  setupSwarm() {
    const topicHash = crypto.createHash('sha256')
      .update(this.topic + this.secret)
      .digest();

    this.swarm.join(topicHash, { lookup: true, announce: true });

    this.swarm.on('connection', (connection, info) => {
      console.log(`New P2P Connection: ${this.topic}`);
      
      this.peers.add(connection);
      
      setTimeout(() => this.broadcastUserCount(), 100);
      
      this.messages.forEach(msg => {
        this.sendToPeer(connection, msg);
      });

      connection.on('data', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message, connection);
        } catch (err) {
          console.error('Error processing P2P message:', err);
        }
      });

      connection.on('close', () => {
        this.peers.delete(connection);
        console.log(`P2P Connection closed at ${this.topic}`);
        setTimeout(() => this.broadcastUserCount(), 100);
      });

      connection.on('error', (err) => {
        console.error('Error at the P2P connection:', err);
        this.peers.delete(connection);
        setTimeout(() => this.broadcastUserCount(), 100);
      });
    });

    this.swarm.on('error', (err) => {
      console.error('Error at the swarm:', err);
    });
  }

  handleMessage(message, fromConnection) {
    if (message.type === 'chat') {
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }

      this.messages.push(message);
      
      if (this.messages.length > 100) {
        this.messages.shift();
      }

      this.peers.forEach(peer => {
        if (peer !== fromConnection) {
          this.sendToPeer(peer, message);
        }
      });

      this.socketClients.forEach(socketId => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('message', message);
        }
      });
    }
  }

  sendToPeer(connection, message) {
    try {
      connection.write(JSON.stringify(message));
    } catch (err) {
      console.error('Error sending message to peer:', err);
    }
  }

  addSocketClient(socketId) {
    this.socketClients.add(socketId);
    setTimeout(() => this.broadcastUserCount(), 100);
  }

  removeSocketClient(socketId) {
    this.socketClients.delete(socketId);
    setTimeout(() => this.broadcastUserCount(), 100);
  }

  sendMessage(message) {
    const chatMessage = {
      type: 'chat',
      username: message.username,
      text: message.text,
      timestamp: Date.now()
    };

    this.handleMessage(chatMessage, null);
  }

  getUserCount() {
    return this.socketClients.size + this.peers.size;
  }

  broadcastUserCount() {
    const userCount = this.getUserCount();
    this.socketClients.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('user-count', { count: userCount });
      }
    });
  }

  destroy() {
    try {
      this.swarm.destroy();
    } catch (err) {
      console.error('Error destroying swarm:', err);
    }
  }
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (data) => {
    try {
      const { topic, secret, username } = data;
      
      if (!topic || !secret || !username) {
        socket.emit('error', 'Topic, secret, and username are required');
        return;
      }

      const roomKey = `${topic}:${crypto.createHash('md5').update(secret).digest('hex').substr(0, 8)}`;
      
      if (userSockets.has(socket.id)) {
        const oldRoom = userSockets.get(socket.id);
        if (activeRooms.has(oldRoom)) {
          /*   ╱|、      
              (˚ˎ 。7     
              |、˜〵     
              じしˍ,)ノ  
          */
          activeRooms.get(oldRoom).removeSocketClient(socket.id);
        }
      }

      if (!activeRooms.has(roomKey)) {
        activeRooms.set(roomKey, new ChatRoom(topic, secret));
      }

      const room = activeRooms.get(roomKey);
      room.addSocketClient(socket.id);
      userSockets.set(socket.id, roomKey);

      socket.emit('joined-room', { 
        topic, 
        messages: room.messages,
        userCount: room.getUserCount()
      });

      room.sendMessage({
        username: 'System',
        text: `${username} entered the room`,
      });

    } catch (err) {
      console.error('Error when joining room:', err);
      socket.emit('error', 'Internal server error');
    }
  });

  socket.on('send-message', (data) => {
    try {
      const roomKey = userSockets.get(socket.id);
      if (!roomKey || !activeRooms.has(roomKey)) {
        socket.emit('error', 'You are not in a room');
        return;
      }

      const room = activeRooms.get(roomKey);
      room.sendMessage(data);
    } catch (err) {
      console.error('Error sending message:', err);
      socket.emit('error', 'Error sending message');
    }
  });

  socket.on('disconnect', () => {
    try {
      console.log('Client Disconnected:', socket.id);
      
      const roomKey = userSockets.get(socket.id);
      if (roomKey && activeRooms.has(roomKey)) {
        const room = activeRooms.get(roomKey);
        room.removeSocketClient(socket.id);
        
        if (room.socketClients.size === 0) {
          setTimeout(() => {
            if (activeRooms.has(roomKey) && activeRooms.get(roomKey).socketClients.size === 0) {
              activeRooms.get(roomKey).destroy();
              activeRooms.delete(roomKey);
              console.log(`Room ${roomKey} removed due to inactivity`);
            }
          }, 300000);
        }
      }
      
      userSockets.delete(socket.id);
    } catch (err) {
      console.error('Error disconnecting a client:', err);
    }
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });
});

setInterval(() => {
  activeRooms.forEach((room, key) => {
    if (room.socketClients.size === 0 && room.peers.size === 0) {
      room.destroy();
      activeRooms.delete(key);
      console.log(`Room ${key} removed due to periodic cleanup`);
    }
  });
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Running @ ${PORT}`);
});