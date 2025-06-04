const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")

const app = express()
const server = http.createServer(app)

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

app.use(cors())
app.use(express.json())

// Store room data in memory (in production, use Redis or database)
const rooms = new Map()
const users = new Map()

// Helper functions
function getRoomData(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      lines: [],
      cursors: new Map(),
    })
  }
  return rooms.get(roomId)
}

function broadcastToRoom(roomId, event, data, excludeSocketId = null) {
  const room = getRoomData(roomId)
  room.users.forEach((user, socketId) => {
    if (socketId !== excludeSocketId) {
      io.to(socketId).emit(event, data)
    }
  })
}

function getRoomUsers(roomId) {
  const room = getRoomData(roomId)
  return Array.from(room.users.values())
}

function getRoomCursors(roomId) {
  const room = getRoomData(roomId)
  return Array.from(room.cursors.values())
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // Join room
  socket.on("join-room", (data) => {
    const { roomId, userInfo } = data
    console.log(`User ${userInfo.nickname} joining room ${roomId}`)

    const room = getRoomData(roomId)

    // Add user to room
    const user = {
      id: socket.id,
      nickname: userInfo.nickname,
      emoji: userInfo.emoji,
      isDrawing: false,
      lastSeen: Date.now(),
    }

    room.users.set(socket.id, user)
    users.set(socket.id, { roomId, userInfo })

    // Join socket room
    socket.join(roomId)

    // Send current room state to new user
    socket.emit("room-state", {
      users: getRoomUsers(roomId),
      lines: room.lines,
      cursors: getRoomCursors(roomId),
    })

    // Notify others about new user
    broadcastToRoom(
      roomId,
      "user-joined",
      {
        user,
        users: getRoomUsers(roomId),
      },
      socket.id,
    )

    console.log(`Room ${roomId} now has ${room.users.size} users`)
  })

  // Handle drawing updates
  socket.on("drawing-update", (data) => {
    const userInfo = users.get(socket.id)
    if (!userInfo) return

    const { roomId } = userInfo
    const room = getRoomData(roomId)

    // Update or add line
    const existingLineIndex = room.lines.findIndex((line) => line.id === data.id)
    if (existingLineIndex >= 0) {
      room.lines[existingLineIndex] = data
    } else {
      room.lines.push(data)
    }

    // Update user drawing status
    const user = room.users.get(socket.id)
    if (user) {
      user.isDrawing = true
      user.lastSeen = Date.now()
    }

    // Broadcast to other users in room
    broadcastToRoom(roomId, "drawing-update", data, socket.id)
  })

  // Handle cursor movement
  socket.on("cursor-move", (data) => {
    const userInfo = users.get(socket.id)
    if (!userInfo) return

    const { roomId } = userInfo
    const room = getRoomData(roomId)

    // Update cursor position
    const cursor = {
      id: socket.id,
      x: data.x,
      y: data.y,
      nickname: userInfo.userInfo.nickname,
      emoji: userInfo.userInfo.emoji,
      lastSeen: Date.now(),
    }

    room.cursors.set(socket.id, cursor)

    // Broadcast cursor position to other users
    broadcastToRoom(roomId, "cursor-update", cursor, socket.id)
  })

  // Handle emoji reactions
  socket.on("emoji-reaction", (data) => {
    const userInfo = users.get(socket.id)
    if (!userInfo) return

    const { roomId } = userInfo

    // Broadcast emoji reaction to all users in room
    broadcastToRoom(roomId, "emoji-reaction", {
      ...data,
      userId: socket.id,
      userInfo: userInfo.userInfo,
    })
  })

  // Handle canvas clear
  socket.on("clear-canvas", () => {
    const userInfo = users.get(socket.id)
    if (!userInfo) return

    const { roomId } = userInfo
    const room = getRoomData(roomId)

    // Clear all lines
    room.lines = []

    // Broadcast clear to all users in room
    broadcastToRoom(roomId, "canvas-cleared", {})
  })

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)

    const userInfo = users.get(socket.id)
    if (userInfo) {
      const { roomId } = userInfo
      const room = getRoomData(roomId)

      // Remove user from room
      room.users.delete(socket.id)
      room.cursors.delete(socket.id)
      users.delete(socket.id)

      // Notify others about user leaving
      broadcastToRoom(roomId, "user-left", {
        userId: socket.id,
        users: getRoomUsers(roomId),
      })

      console.log(`User left room ${roomId}, ${room.users.size} users remaining`)

      // Clean up empty rooms
      if (room.users.size === 0) {
        rooms.delete(roomId)
        console.log(`Room ${roomId} deleted (empty)`)
      }
    }
  })

  // Periodic cleanup of inactive cursors
  setInterval(() => {
    const now = Date.now()
    rooms.forEach((room, roomId) => {
      room.cursors.forEach((cursor, socketId) => {
        if (now - cursor.lastSeen > 10000) {
          // 10 seconds
          room.cursors.delete(socketId)
        }
      })

      // Update user drawing status
      room.users.forEach((user) => {
        if (now - user.lastSeen > 5000) {
          // 5 seconds
          user.isDrawing = false
        }
      })
    })
  }, 5000)
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🚀 Drawing collaboration server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready for real-time collaboration`)
})

