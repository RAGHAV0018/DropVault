/**
 * DropVault — Database Connection Configuration
 */

const mongoose = require("mongoose");

/**
 * Human-readable mapping of Mongoose readyState values.
 */
const CONNECTION_STATES = {
  0: "Disconnected",
  1: "Connected",
  2: "Connecting",
  3: "Disconnecting",
  99: "Uninitialized",
};

/**
 * Returns the current human-readable connection state.
 * @returns {string} e.g., "Connected", "Disconnected"
 */
const getConnectionStatus = () => {
  const stateCode = mongoose.connection.readyState;
  return CONNECTION_STATES[stateCode] || `Unknown (${stateCode})`;
};

/**
 * Connects to MongoDB Atlas using the MONGO_URI environment variable.
 * Configures connection options, event listeners, and error handling.
 *
 * @returns {Promise<typeof mongoose>}
 */
const connectDB = async () => {
  const uri = process.env.MONGO_URI;

  // 1. Validate that the environment variable is configured
  if (!uri) {
    console.error("\n❌ [MongoDB] Error: MONGO_URI environment variable is not defined!");
    console.error("👉 Please add MONGO_URI to your .env file.");
    console.error("   Example: MONGO_URI=mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/dropvault?retryWrites=true&w=majority\n");
    process.exit(1);
  }

  // 2. Setup Lifecycle Event Listeners (Post-connection / runtime monitoring)
  // These fire for events that occur during the lifetime of the application.

  // Fires if an error occurs on the established connection
  mongoose.connection.on("error", (err) => {
    console.error(`❌ [MongoDB] Runtime connection error: ${err.message}`);
  });

  // Fires when the connection is temporarily lost (e.g., network hiccup, Atlas maintenance)
  mongoose.connection.on("disconnected", () => {
    console.warn(`⚠️ [MongoDB] Connection lost. Current state: ${getConnectionStatus()}`);
  });

  // Fires when Mongoose successfully reconnects after a disconnect
  mongoose.connection.on("reconnected", () => {
    console.log(`🔄 [MongoDB] Reconnected successfully. Current state: ${getConnectionStatus()}`);
  });

  // Fires when the connection is opened and ready to write
  mongoose.connection.on("connected", () => {
    console.log(`🔌 [MongoDB] Connection established to host: ${mongoose.connection.host}`);
  });

  // 3. Establish the Initial Connection
  try {
    console.log(`[MongoDB] Initiating connection... (Current State: ${getConnectionStatus()})`);

    // Mongoose 6+ has sensible defaults enabled out-of-the-box:
    // - useNewUrlParser: true (handled automatically)
    // - useUnifiedTopology: true (handled automatically)
    //
    // Additional recommended connection options for production / Atlas:
    const options = {
      // Milliseconds to wait for a server selection before throwing an error (default: 30000)
      serverSelectionTimeoutMS: 10000,
      // Milliseconds to keep an idle socket open
      socketTimeoutMS: 45000,
      // Maximum number of concurrent connections in the connection pool
      maxPoolSize: 10,
    };

    const conn = await mongoose.connect(uri, options);

    console.log(`✅ [MongoDB] Connected: ${conn.connection.name} @ ${conn.connection.host}:${conn.connection.port}`);
    console.log(`📊 [MongoDB] State: ${getConnectionStatus()} (code: ${mongoose.connection.readyState})`);

    return conn;
  } catch (error) {
    // Initial connection error handling:
    // This catches authentication errors (bad credentials), DNS resolution failures,
    // or IP access list / whitelist blocks from Atlas.
    console.error(`\n❌ [MongoDB] Initial connection failed!`);
    console.error(`   Message: ${error.message}`);

    // Provide friendly diagnostics for the most common MongoDB Atlas setup issues
    if (error.message.includes("bad auth") || error.message.includes("Authentication failed")) {
      console.error("   💡 Tip: Check your database username and password in MONGO_URI.");
      console.error("      Remember: If your password contains special characters (@, :, %, etc.),");
      console.error("      they must be URL-encoded (e.g., @ becomes %40).");
    } else if (error.message.includes("ENOTFOUND") || error.message.includes("querySrv")) {
      console.error("   💡 Tip: Unable to resolve cluster hostname. Check your cluster domain in MONGO_URI.");
    } else if (error.message.includes("whitelist") || error.message.includes("timed out") || error.name === "MongooseServerSelectionError") {
      console.error("   💡 Tip: Connection timed out. Ensure your current IP address is whitelisted");
      console.error("      in MongoDB Atlas under 'Network Access' (or set to 0.0.0.0/0 for development).");
    }

    // Exit process with failure code — the backend should not run without its database
    process.exit(1);
  }
};

/**
 * Gracefully closes the database connection.
 * Used during server shutdown (SIGINT / SIGTERM).
 */
const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.connection.close(false);
      console.log("[MongoDB] Connection closed gracefully.");
    } catch (err) {
      console.error(`[MongoDB] Error during disconnect: ${err.message}`);
    }
  }
};

module.exports = {
  connectDB,
  disconnectDB,
  getConnectionStatus,
  CONNECTION_STATES,
};

