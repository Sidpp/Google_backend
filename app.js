// =================================================================
// Main Server File (e.g., index.js or app.js)
// =================================================================
require('dotenv').config(); // Ensures environment variables are loaded first

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { connectDB } = require('./db'); // Import the connectDB function
const authenticateRequest = require('./middleware/auth');
const apiLimiter = require('./middleware/rateLimit');
const authRoutes = require('./routes/authRoutes');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware Setup ---

// Trust the first proxy. This is important for rate limiting and secure cookies 
// when deployed behind a reverse proxy like on Render.
app.set('trust proxy', 1); 

// Simple request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request for: ${req.originalUrl}`);
  next();
});

// Enable Cross-Origin Resource Sharing for all routes
app.use(cors());

// Parse incoming request bodies
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// --- Route Definitions ---
app.use('/auth', authRoutes);
// Apply rate limiting and authentication middleware only to the /api routes
app.use('/api', apiLimiter, authenticateRequest, apiRoutes);


// --- Database Connection and Server Initialization ---
// This is the critical part. We wrap the server start logic in a function
// that only runs after a successful database connection.
const startServer = async () => {
    try {
        // Attempt to connect to the database first.
        await connectDB();
        console.log("Successfully connected to the database.");

        // If the connection is successful, start the Express server.
        app.listen(port, () => {
            console.log(`API Server running on port ${port}`);
        });

    } catch (err) {
        // If the database connection fails, log the error and exit the process.
        // This prevents the server from running in a faulty state.
        console.error("Failed to connect to the database. Server did not start.", err);
        process.exit(1);
    }
};

// Execute the function to start the server.
startServer();
