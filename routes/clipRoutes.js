/**
 * DropVault — Clipboard API Routes
 */

const express = require("express");
const router = express.Router();
const { Clip } = require("../models/Clip");

/**
 * POST /api/clip
 * Saves a new clipboard snippet for a room.
 */
router.post("/", async (req, res, next) => {
  try {
    const { roomCode, content, clientId } = req.body;

    // 1. Client-Side Input Validation
    // Missing required fields
    if (!roomCode || !content) {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          status: "Bad Request",
          message: "Both 'roomCode' and 'content' fields are required.",
        },
      });
    }

    const trimmedRoomCode = String(roomCode).trim();
    const trimmedContent = String(content).trim();

    // Validate 4-digit numeric format
    if (!/^\d{4}$/.test(trimmedRoomCode)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          status: "Bad Request",
          message: "Invalid room code format. Must be a 4-digit numeric code (e.g., 8492).",
        },
      });
    }

    // Validate non-empty content
    if (trimmedContent.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          status: "Bad Request",
          message: "Clip content cannot be empty or whitespace only.",
        },
      });
    }

    // 2. Database Persistence
    // Creates a new document in MongoDB Atlas. Mongoose runs schema validation
    // and sets `createdAt` to Date.now with the 600-second TTL index.
    const newClip = await Clip.create({
      roomCode: trimmedRoomCode,
      content: trimmedContent,
    });

    console.log(`[Clip API] Saved new clip for room ${trimmedRoomCode} (ID: ${newClip._id})`);

    // 3. Real-Time Push Notification (Optional Bridge to Socket.io)
    // If Socket.io instance was attached to Express app, immediately push this
    // clip to the second device in the room so they don't even have to poll!
    const io = req.app.get("io");
    if (io) {
      io.to(trimmedRoomCode).emit("clip-received", {
        clipId: newClip._id,
        roomCode: trimmedRoomCode,
        content: newClip.content,
        createdAt: newClip.createdAt,
        // Echoed so the author can ignore their own save. Applying it back
        // into the textarea would schedule another POST and loop.
        clientId: typeof clientId === "string" ? clientId : null,
      });
    }

    // 4. Return HTTP 201 Created
    // 201 explicitly signifies that a new resource was created in the database.
    return res.status(201).json({
      success: true,
      message: "Clip saved successfully. Will expire in 10 minutes.",
      data: {
        id: newClip._id,
        roomCode: newClip.roomCode,
        content: newClip.content,
        createdAt: newClip.createdAt,
      },
    });
  } catch (error) {
    console.error("[Clip API] Error in POST /api/clip:", error.message);

    // If it's a Mongoose validation error, return 400
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          status: "Bad Request",
          message: error.message,
        },
      });
    }

    // Otherwise, return 500 Internal Server Error (or pass to global error handler)
    return res.status(500).json({
      success: false,
      error: {
        code: 500,
        status: "Internal Server Error",
        message: "Failed to persist clip to database.",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
});

/**
 * GET /api/clip/:roomCode
 * Retrieves active clips for a room code.
 */
router.get("/:roomCode", async (req, res, next) => {
  try {
    const rawRoomCode = req.params.roomCode;
    const roomCode = String(rawRoomCode || "").trim();

    // 1. Validate URL Parameter Format
    if (!/^\d{4}$/.test(roomCode)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          status: "Bad Request",
          message: "Invalid room code format. Room code must be exactly 4 digits.",
        },
      });
    }

    // 2. Query MongoDB with Sub-Second Freshness Filter
    // In addition to the TTL index (which purges every ~60s), we explicitly
    // filter by (Date.now - 600s) to guarantee clients never receive stale clips.
    const ttlWindowMs = 600 * 1000; // 10 minutes
    const expirationThreshold = new Date(Date.now() - ttlWindowMs);

    const clips = await Clip.find({
      roomCode,
      createdAt: { $gt: expirationThreshold },
    })
      .sort({ createdAt: -1 }) // Newest clips first
      .lean(); // .lean() returns plain JS objects instead of heavy Mongoose Documents

    // 3. Handle Resource Absence (404 Not Found)
    // If no active clips exist for this room code, return HTTP 404
    if (!clips || clips.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 404,
          status: "Not Found",
          message: `No active clips found for room ${roomCode}. The clip may have expired or not yet been shared.`,
          roomCode,
        },
      });
    }

    // 4. Return HTTP 200 OK
    // 200 indicates standard successful retrieval of the requested resource.
    console.log(`[Clip API] Retrieved ${clips.length} clip(s) for room ${roomCode}`);

    return res.status(200).json({
      success: true,
      roomCode,
      count: clips.length,
      data: clips.map((clip) => ({
        id: clip._id,
        roomCode: clip.roomCode,
        content: clip.content,
        createdAt: clip.createdAt,
      })),
    });
  } catch (error) {
    console.error(`[Clip API] Error in GET /api/clip/${req.params.roomCode}:`, error.message);

    // Return 500 Internal Server Error
    return res.status(500).json({
      success: false,
      error: {
        code: 500,
        status: "Internal Server Error",
        message: "Failed to retrieve clips from database.",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
});

module.exports = router;

