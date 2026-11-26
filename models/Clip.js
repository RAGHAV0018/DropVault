/**
 * DropVault — Temporary Clipboard Snippet Model
 */

const mongoose = require("mongoose");

const ClipSchema = new mongoose.Schema(
  {
    // The 4-digit code identifying the DropVault room (e.g., "8492")
    roomCode: {
      type: String,
      required: [true, "Room code is required"],
      trim: true,
      index: true, // Speeds up queries filtering by roomCode
    },

    // The text snippet / clipboard data shared between devices
    content: {
      type: String,
      required: [true, "Clip content cannot be empty"],
      trim: true,
      maxlength: [50000, "Clip content exceeds maximum limit of 50,000 characters"],
    },

    // Timestamp when the clip was created.
    // `expires: 600` instructs MongoDB to create a TTL index that automatically
    // removes the document ~600 seconds (10 minutes) after this timestamp.
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 600, // 600 seconds = 10 minutes
    },
  },
  {
    // Disable Mongoose's internal __v version key for lightweight temporary records
    versionKey: false,
  }
);

// Compound index for fast queries: fetch the most recent clips for a specific room
ClipSchema.index({ roomCode: 1, createdAt: -1 });

// Compile and export the Mongoose Model
const Clip = mongoose.model("Clip", ClipSchema);

module.exports = {
  Clip,
  ClipSchema,
};

