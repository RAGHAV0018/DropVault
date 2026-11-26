// DropVault — Real-time P2P file & clipboard sharing server
require("dotenv").config();

const express = require("express");

// Node's built-in http module — we need this to create a raw HTTP server
// that BOTH Express and Socket.io can attach to. If we just used app.listen(),
// Express would create its own server internally, and Socket.io wouldn't
// have a reference to attach to.
const http = require("http");

// Destructure the Server class from socket.io. This is the server-side engine
// that manages all WebSocket connections, rooms, and event broadcasting.
const { Server } = require("socket.io");

const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { connectDB, disconnectDB } = require("./config/db");
const clipRoutes = require("./routes/clipRoutes");

// Create the Express app (handles HTTP routes) and the raw HTTP server.
// Think of `app` as the "brain" (routing logic) and `server` as the
// "body" (the actual network listener on port 3000).
const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// CORS CONFIGURATION
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Read configured frontend origins from environment variables.
// Accepts comma-separated values: "https://dropvault.vercel.app,https://dropvault-preview.vercel.app"
const rawAllowedOrigins = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || "";
const allowedOrigins = rawAllowedOrigins
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, "")) // Strip accidental trailing slashes
  .filter(Boolean);

// Always ensure local development hosts and same-origin ports are whitelisted
const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];
defaultOrigins.forEach((origin) => {
  if (!allowedOrigins.includes(origin)) {
    allowedOrigins.push(origin);
  }
});

/**
 * Validates whether an incoming HTTP or WebSocket request origin is permitted.
 *
 * @param {string|undefined} origin - The Origin header sent by the client browser.
 * @returns {boolean} True if permitted, false otherwise.
 */
function isOriginAllowed(origin) {
  // Allow server-to-server, mobile native webviews, curl, Postman, or health checks (no Origin header)
  if (!origin) return true;

  const normalized = origin.trim().replace(/\/+$/, "");

  // 1. Check exact match in configured whitelist
  if (allowedOrigins.includes(normalized)) return true;

  // 2. Dynamic check for Vercel preview branch deployments if base Vercel domain is configured
  // e.g. https://dropvault-git-feat-username.vercel.app matching a configured *.vercel.app domain
  const hasVercelDomain = allowedOrigins.some((o) => o.includes(".vercel.app"));
  if (hasVercelDomain && /^https:\/\/[a-z0-9-]+(\.vercel\.app)$/i.test(normalized)) {
    return true;
  }

  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS Blocked] Origin '${origin}' not permitted. Whitelist: ${allowedOrigins.join(", ")}`);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 200, // Legacy browsers (IE11) choke on 204
};

// Apply CORS middleware to ALL Express HTTP routes
app.use(cors(corsOptions));
// Explicitly respond to CORS preflight (OPTIONS) requests across all routes
app.options(/.*/, cors(corsOptions));

// ---------------------------------------------------------------------------
// SOCKET.IO SERVER — Wrapping the HTTP Server
// ---------------------------------------------------------------------------
// Socket.io manages persistent bidirectional WebSocket connections.
// Because the initial WebSocket handshake starts as an HTTP upgrade request,
// Socket.io requires its own CORS configuration matching Express.
// ---------------------------------------------------------------------------
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Socket.io CORS: Origin ${origin} not allowed`));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },

  // HEARTBEAT MECHANISM — How Socket.io detects dead connections:
  // The server sends a "ping" to each client every `pingInterval` ms.
  // If the client doesn't respond with a "pong" within `pingTimeout` ms,
  // Socket.io considers the connection dead and fires the "disconnect" event.
  //
  // For DropVault: If someone closes their laptop lid mid-transfer,
  // the other device knows within ~85 seconds (25s interval + 60s timeout).
  pingTimeout: 60000,   // 60 seconds — how long to wait for a pong response
  pingInterval: 25000,  // 25 seconds — how often to send a ping

  // Maximum size of a single WebSocket message in bytes.
  // 1e7 = 10,000,000 bytes = ~10 MB. Anything larger gets rejected.
  // For DropVault: Small text snippets and clipboard data go through Socket.io.
  // Large files (100MB+) will use WebRTC peer-to-peer instead, bypassing
  // the server entirely and avoiding this limit.
  maxHttpBufferSize: 1e7,

  // Transport preference order:
  // "websocket" — Try the fast, persistent WebSocket connection first.
  // "polling"   — Fall back to HTTP long-polling if WebSocket fails
  //               (e.g., behind a restrictive corporate proxy/firewall).
  //
  // HTTP long-polling works like this: the client sends a GET request,
  // the server HOLDS it open (doesn't respond immediately), and only
  // sends a response when it has data. The client immediately sends
  // another GET. This simulates real-time but uses more bandwidth.
  transports: ["websocket", "polling"],
});

// Attach Socket.io instance to Express app so route handlers can access it
// via `req.app.get("io")` to emit real-time push events to rooms on REST calls.
app.set("io", io);

// ---------------------------------------------------------------------------
// EXPRESS MIDDLEWARE STACK
// ---------------------------------------------------------------------------
// Middleware functions run in ORDER for every incoming HTTP request.
// Think of them as a series of checkpoints a request passes through
// before reaching a route handler (GET /health, POST /upload, etc.).
// ---------------------------------------------------------------------------

// Helmet adds ~15 security-related HTTP headers to every response.
// Example: X-Content-Type-Options: nosniff (prevents MIME-type sniffing attacks)
// contentSecurityPolicy is disabled because it can block inline scripts
// and styles that our frontend might need. We'll fine-tune this in production.
app.use(helmet({ contentSecurityPolicy: false }));

// Morgan logs every HTTP request to the console.
// "dev" format: concise, colorized (GET /health 200 3.542 ms)
// "combined" format: full Apache-style logs with IP, user-agent, etc.
// Note: Morgan only logs HTTP requests. Socket.io WebSocket messages
// are NOT logged by Morgan — they bypass HTTP after the initial handshake.
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Parse incoming JSON request bodies (e.g., { "text": "hello from phone" }).
// Without this, req.body would be undefined when the frontend sends JSON.
// The 10mb limit prevents attackers from sending enormous payloads that
// could crash the server by consuming all available memory.
app.use(express.json({ limit: "10mb" }));

// Parse URL-encoded form data (traditional HTML <form> submissions).
// `extended: true` uses the `qs` library for rich object parsing.
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve static frontend build from frontend/dist if available, else fallback to public
const distPath = path.join(__dirname, "frontend", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  app.use(express.static(path.join(__dirname, "public")));
}

// ---------------------------------------------------------------------------
// HTTP ROUTES (Standard Request-Response)
// ---------------------------------------------------------------------------
// These follow the traditional HTTP pattern: client asks, server answers, done.
// Contrast this with the Socket.io section below, which stays connected.
// ---------------------------------------------------------------------------

// Health check endpoint — used by monitoring tools, load balancers, and
// deployment pipelines to verify the server is alive and responsive.
// This is a pure HTTP endpoint: request in, response out, connection done.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Clipboard REST API: Save and retrieve temporary text snippets for a room
app.use("/api/clip", clipRoutes);

// SPA fallback: for client-side routing, serve index.html from frontend/dist
// Note for Express 5: app.get('*') throws a PathError due to path-to-regexp v8.
// Using a pathless app.use middleware safely handles all unmatched GET requests.
if (fs.existsSync(distPath)) {
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/socket.io") ||
      req.path === "/health"
    ) {
      return next();
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// SOCKET.IO MIDDLEWARE
// ---------------------------------------------------------------------------
// Just like Express has app.use() middleware that runs before route handlers,
// Socket.io has io.use() middleware that runs before the "connection" event.
// Each connecting client passes through this middleware ONCE during handshake.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  // socket.handshake contains all the data sent during the initial connection:
  // - auth: custom authentication data sent by the client
  // - headers: HTTP headers from the upgrade request
  // - query: URL query parameters
  //
  // For DropVault (zero-login): We don't need traditional auth tokens.
  // Later, we'll validate the 4-digit room code here instead.
  const token = socket.handshake.auth?.token;
  if (token) {
    socket.data.authenticated = true;
  }
  // next() = allow the connection to proceed.
  // next(new Error("...")) = reject the connection.
  next();
});

// ---------------------------------------------------------------------------
// ROOM CODE GENERATOR (4-Digit Unique Codes)
// ---------------------------------------------------------------------------
// DropVault uses 4-digit numeric room codes (1000–9999) for quick pairing
// across devices (similar to Apple AirDrop pairing codes or Apple TV setup).
//
// Why 4 digits?
//   - Fast to type on mobile keyboards (numeric keypad only).
//   - 9,000 possible active rooms (1000 through 9999) is plenty for active
//     concurrent transfers.
//   - Zero logins, passwords, or emails required.
//
// Collision Handling:
//   Before assigning a code, we check Socket.io's in-memory adapter.
//   If a room with that code already exists and is active, we retry with
//   a new random number using Node's cryptographically secure crypto.randomInt.
// ---------------------------------------------------------------------------
const generateUniqueRoomCode = (ioInstance) => {
  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Generate a cryptographically secure random integer between 1000 and 9999
    const code = crypto.randomInt(1000, 10000).toString();

    // Query Socket.io's in-memory adapter to check if this room key is occupied
    const activeRoom = ioInstance.sockets.adapter.rooms.get(code);
    if (!activeRoom || activeRoom.size === 0) {
      return code;
    }
  }
  throw new Error("Unable to allocate unique room code: server room capacity reached");
};

// ---------------------------------------------------------------------------
// Socket.io Connection & Room Events
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  // This fires every time a new WebSocket client connects.
  // `socket` represents one individual connection (one device/browser tab).
  // `socket.id` is a unique identifier for this connection (e.g., "xK7_2bHqABC").
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // 1. Create Room (Host)
  socket.on("create-room", (callback) => {
    try {
      // If this socket was already in an existing room, leave it first
      if (socket.data.roomCode) {
        socket.leave(socket.data.roomCode);
        console.log(`[Socket.io] ${socket.id} left previous room: ${socket.data.roomCode}`);
      }

      // Generate a collision-free 4-digit code (checks adapter.rooms)
      const roomCode = generateUniqueRoomCode(io);

      // Put the host into their own private room in server memory.
      // Under the hood: adapter.rooms.get(roomCode).add(socket.id)
      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      console.log(`[Socket.io] Room ${roomCode} created by host socket: ${socket.id}`);

      const responsePayload = {
        success: true,
        roomCode,
        message: `Room ${roomCode} created successfully. Waiting for peer to join...`,
      };

      // Support both acknowledgement callback (standard in client apps)
      // and explicit event emission ('room-created')
      if (typeof callback === "function") {
        callback(responsePayload);
      }
      socket.emit("room-created", responsePayload);
    } catch (err) {
      console.error(`[Socket.io] Error creating room for ${socket.id}:`, err.message);
      const errorPayload = {
        success: false,
        message: err.message,
      };
      if (typeof callback === "function") {
        callback(errorPayload);
      }
      socket.emit("room-create-error", errorPayload);
    }
  });

  // 2. Join Room (Guest)
  socket.on("join-room", (payload, callback) => {
    // Support either a raw string "8492" or an object payload { roomCode: "8492" }
    const rawCode =
      typeof payload === "object" && payload !== null
        ? payload.roomCode || payload.roomId
        : payload;
    const roomCode = String(rawCode || "").trim();

    // Helper to send errors consistently via callback and event
    const sendError = (message) => {
      const errResponse = { success: false, message, roomCode };
      if (typeof callback === "function") callback(errResponse);
      socket.emit("room-join-error", errResponse);
      console.warn(`[Socket.io] ${socket.id} failed to join room '${roomCode}': ${message}`);
    };

    // 1. Validation: 4-digit numeric format check
    if (!/^\d{4}$/.test(roomCode)) {
      return sendError("Invalid room code. Please enter a 4-digit numeric code (e.g. 8492).");
    }

    // 2. Existence Check: Inspect Socket.io's in-memory adapter
    // io.sockets.adapter.rooms is a Map<string, Set<string>>
    const targetRoom = io.sockets.adapter.rooms.get(roomCode);
    const shouldCreate =
      typeof payload === "object" && payload !== null && payload.create === true;
    if (!targetRoom || targetRoom.size === 0) {
      // The home screen picks the 4-digit code. Hosts open that room here
      // instead of waiting for the server to mint a different one.
      if (!shouldCreate) {
        return sendError(`Room ${roomCode} does not exist or has expired. Ask the host to create it.`);
      }

      if (socket.data.roomCode && socket.data.roomCode !== roomCode) {
        socket.leave(socket.data.roomCode);
      }

      socket.join(roomCode);
      socket.data.roomCode = roomCode;

      const createdResponse = {
        success: true,
        roomCode,
        peerId: null,
        created: true,
        message: `Room ${roomCode} is open.`,
      };

      console.log(`[Socket.io] Room ${roomCode} opened by host socket: ${socket.id}`);
      if (typeof callback === "function") callback(createdResponse);
      socket.emit("room-joined", createdResponse);
      return;
    }

    // 3. Duplicate Check: Ensure this client isn't already in this room
    if (targetRoom.has(socket.id)) {
      return sendError(`You are already in room ${roomCode}.`);
    }

    // 4. Capacity Check: DropVault pairs 2 devices (Host + Peer) for 1-to-1 transfer
    const MAX_ROOM_CAPACITY = 2;
    if (targetRoom.size >= MAX_ROOM_CAPACITY) {
      return sendError(`Room ${roomCode} is full (maximum ${MAX_ROOM_CAPACITY} devices allowed).`);
    }

    // If socket is in a previous room, leave it
    if (socket.data.roomCode && socket.data.roomCode !== roomCode) {
      socket.leave(socket.data.roomCode);
    }

    // 5. In-Memory Join Operation
    // Adds socket.id to adapter.rooms.get(roomCode)
    // Adds roomCode to adapter.sids.get(socket.id)
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    // Identify the host (the peer who was already waiting in the room)
    const existingPeers = Array.from(targetRoom).filter((id) => id !== socket.id);

    console.log(
      `[Socket.io] Device ${socket.id} joined room ${roomCode} (Total devices: ${targetRoom.size})`
    );

    const successResponse = {
      success: true,
      roomCode,
      peerId: existingPeers[0] || null,
      message: `Successfully connected to room ${roomCode}.`,
    };

    // Acknowledge joining device
    if (typeof callback === "function") callback(successResponse);
    socket.emit("room-joined", successResponse);

    // 6. ISOLATED NOTIFICATION TO EXISTING DEVICE(S):
    // `socket.to(roomCode).emit(...)`
    // This broadcasts ONLY to the other socket(s) currently in roomCode.
    // The joining socket is excluded. Devices in other rooms never receive it.
    socket.to(roomCode).emit("peer-joined", {
      peerId: socket.id,
      roomCode,
      timestamp: Date.now(),
    });

    // Backward-compatible alias for existing frontend code
    socket.to(roomCode).emit("user-joined", {
      socketId: socket.id,
      roomId: roomCode,
      roomCode,
      timestamp: Date.now(),
    });
  });

  // 3. Leave Room
  socket.on("leave-room", (payload, callback) => {
    const rawCode =
      typeof payload === "object" && payload !== null
        ? payload.roomCode || payload.roomId
        : payload;
    const roomCode = rawCode || socket.data.roomCode;

    if (roomCode) {
      // In-memory removal:
      // adapter.rooms.get(roomCode).delete(socket.id)
      socket.leave(roomCode);
      delete socket.data.roomCode;

      // Notify the other peer in the room that this device left
      socket.to(roomCode).emit("peer-left", {
        peerId: socket.id,
        roomCode,
        reason: "user-initiated",
        timestamp: Date.now(),
      });
      socket.to(roomCode).emit("user-left", {
        socketId: socket.id,
        roomId: roomCode,
        roomCode,
        reason: "user-initiated",
        timestamp: Date.now(),
      });

      console.log(`[Socket.io] ${socket.id} left room: ${roomCode}`);
    }

    if (typeof callback === "function") {
      callback({ success: true, roomCode });
    }
  });

  // 4. WebRTC Signaling Relays
  const forwardOffer = (payload) => {
    const roomCode =
      payload?.roomCode || payload?.roomId || socket.data.roomCode;
    const offer = payload?.offer || payload?.sdp || payload;

    if (!roomCode) {
      return socket.emit("error", {
        message: "Cannot forward WebRTC offer: no active room specified.",
      });
    }

    console.log(`[WebRTC] Forwarding SDP Offer from ${socket.id} in room ${roomCode}`);

    const forwardPayload = {
      senderId: socket.id,
      offer,
      roomCode,
      timestamp: Date.now(),
    };

    // Forward strictly to the other peer in the room
    socket.to(roomCode).emit("webrtc-offer", forwardPayload);
    socket.to(roomCode).emit("offer", forwardPayload);
  };

  socket.on("webrtc-offer", forwardOffer);
  socket.on("offer", forwardOffer);

  // ---- B) WEBRTC ANSWER FORWARDER ----
  // Relays the responding Session Description Protocol (SDP) answer from Callee back to Caller.
  const forwardAnswer = (payload) => {
    const roomCode =
      payload?.roomCode || payload?.roomId || socket.data.roomCode;
    const answer = payload?.answer || payload?.sdp || payload;

    if (!roomCode) {
      return socket.emit("error", {
        message: "Cannot forward WebRTC answer: no active room specified.",
      });
    }

    console.log(`[WebRTC] Forwarding SDP Answer from ${socket.id} in room ${roomCode}`);

    const forwardPayload = {
      senderId: socket.id,
      answer,
      roomCode,
      timestamp: Date.now(),
    };

    // Forward strictly to the initiating peer in the room
    socket.to(roomCode).emit("webrtc-answer", forwardPayload);
    socket.to(roomCode).emit("answer", forwardPayload);
  };

  socket.on("webrtc-answer", forwardAnswer);
  socket.on("answer", forwardAnswer);

  // ---- C) ICE CANDIDATE FORWARDER ----
  // Relays discovered IP/port candidate pairs between peers (trickle ICE).
  const forwardIceCandidate = (payload) => {
    const roomCode =
      payload?.roomCode || payload?.roomId || socket.data.roomCode;
    const candidate =
      payload?.candidate !== undefined ? payload.candidate : payload;

    if (!roomCode) {
      return socket.emit("error", {
        message: "Cannot forward ICE candidate: no active room specified.",
      });
    }

    const forwardPayload = {
      senderId: socket.id,
      candidate,
      roomCode,
      timestamp: Date.now(),
    };

    // Forward candidate strictly to the other peer in the room
    socket.to(roomCode).emit("ice-candidate", forwardPayload);
    socket.to(roomCode).emit("webrtc-ice-candidate", forwardPayload);
  };

  socket.on("ice-candidate", forwardIceCandidate);
  socket.on("webrtc-ice-candidate", forwardIceCandidate);

  // ---- D) GENERIC SIGNALING & CHAT RELAY ----
  // Preserved for fallback signaling or small text messages.
  socket.on("message", (payload) => {
    const roomCode =
      payload?.roomCode || payload?.roomId || socket.data.roomCode;

    if (!roomCode) {
      return socket.emit("error", {
        message: "Cannot relay message: no active room specified.",
      });
    }

    socket.to(roomCode).emit("message", {
      senderId: socket.id,
      data: payload.data !== undefined ? payload.data : payload,
      timestamp: Date.now(),
    });
  });

  socket.on("signal", (payload) => {
    const roomCode =
      payload?.roomCode || payload?.roomId || socket.data.roomCode;

    if (!roomCode) {
      return socket.emit("error", {
        message: "Cannot relay signal: no active room specified.",
      });
    }

    socket.to(roomCode).emit("signal", {
      senderId: socket.id,
      signalData: payload.signalData || payload.data,
      timestamp: Date.now(),
    });
  });

  // 5. Connection Cleanup
  socket.on("disconnecting", (reason) => {
    for (const roomCode of socket.rooms) {
      // Every socket has a default private room matching socket.id.
      // We skip that and only broadcast to our 4-digit application rooms.
      if (roomCode !== socket.id) {
        socket.to(roomCode).emit("peer-left", {
          peerId: socket.id,
          roomCode,
          reason,
          timestamp: Date.now(),
        });
        socket.to(roomCode).emit("user-left", {
          socketId: socket.id,
          roomId: roomCode,
          roomCode,
          reason,
          timestamp: Date.now(),
        });
        console.log(
          `[Socket.io] ${socket.id} disconnected from room ${roomCode} (${reason})`
        );
      }
    }
  });

  // 'disconnect': Fired AFTER all rooms have been left and cleared from memory.
  socket.on("disconnect", (reason) => {
    console.log(`[Socket.io] Client disconnected: ${socket.id} (${reason})`);
  });

  socket.on("error", (err) => {
    console.error(`[Socket.io] Error on ${socket.id}:`, err.message);
  });
});

// ---------------------------------------------------------------------------
// ERROR HANDLING MIDDLEWARE
// ---------------------------------------------------------------------------

// 404 catch-all: if no Express route matched the request, it falls through
// to here. We create an error and pass it to the global error handler below.
app.use((_req, _res, next) => {
  const err = new Error("Not Found");
  err.status = 404;
  next(err);
});

// Global error handler: Express identifies this as an error handler because
// it has EXACTLY 4 parameters (err, req, res, next). This is a special
// Express convention — 3 params = normal middleware, 4 params = error handler.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  // In production, hide internal error details from users (security).
  // In development, show full error messages for easier debugging.
  const message =
    process.env.NODE_ENV === "production" && status === 500
      ? "Internal Server Error"
      : err.message;

  console.error(`[Error] ${status} - ${err.message}`);

  res.status(status).json({
    error: {
      message,
      status,
      // Spread the stack trace only in development. In production, attackers
      // could use stack traces to learn about your file structure and libraries.
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    },
  });
});

// ---------------------------------------------------------------------------
// SERVER STARTUP & GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------

// PORT: hosting platforms (e.g. Render) inject PORT at runtime; always prefer it.
// Local dev falls back to 3000. Bind to 0.0.0.0 in containers/platforms as needed
// by the host environment (Render routes external traffic to the assigned PORT).
// (Defined at top of file for CORS configuration)

// Graceful shutdown: when the server receives a termination signal, it:
//   1. Stops accepting NEW connections
//   2. Closes all existing WebSocket connections (so clients know to reconnect)
//   3. Waits for in-flight HTTP requests to complete
//   4. Force-exits after 10 seconds if something hangs
//
// Without this, killing the server mid-transfer would leave Device B's
// connection in limbo — it wouldn't know the server died until the next
// ping timeout (up to 85 seconds later).
const shutdown = (signal) => {
  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);

  io.close(() => {
    console.log("[Socket.io] All connections closed.");
  });

  server.close(async () => {
    console.log("[Server] HTTP server closed.");
    await disconnectDB();
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[Server] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
};

// SIGTERM: Sent by deployment platforms (Docker, Heroku, AWS) during redeploy.
// SIGINT:  Sent when you press Ctrl+C in the terminal.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Safety nets for unexpected errors:
// unhandledRejection: A Promise rejected but had no .catch() handler.
// uncaughtException:  An error was thrown outside of any try/catch block.
process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught Exception:", err);
  process.exit(1);
});

// Start listening on configured port
server.listen(PORT, async () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[Server] CORS origins: ${allowedOrigins.join(", ")}`);

  // Connect to MongoDB Atlas
  if (process.env.MONGO_URI && !process.env.MONGO_URI.includes("<username>")) {
    await connectDB();
  } else if (process.env.MONGO_URI && process.env.MONGO_URI.includes("<username>")) {
    console.warn("⚠️  [MongoDB] Placeholder detected in MONGO_URI (.env). Please replace with your Atlas connection string.");
  } else {
    console.warn("ℹ️  [MongoDB] MONGO_URI not set in .env. Skipping database connection.");
  }
});

// Export for use in other files (route modules, tests, etc.)
module.exports = { app, server, io };
