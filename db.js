// =================================================================
// Database Connection File (db.js)
// =================================================================
const { MongoClient } = require('mongodb');

// Retrieve the MongoDB connection URI from environment variables.
const uri = process.env.MONGO_URI; // Changed from MONGO_URI to match previous context

// Throw an error at startup if the URI is not defined.
if (!uri) {
    throw new Error('Please define the MONGODB_URI environment variable inside .env');
}

// Create a new MongoClient instance.
const client = new MongoClient(uri);
let db; // This variable will hold the database instance once connected.

/**
 * Connects to the MongoDB database.
 * It implements a singleton pattern to ensure only one connection is established.
 * @returns {Promise<Db>} A promise that resolves to the database instance.
 */
async function connectDB() {
    // If the database connection is already established, return the existing instance.
    if (db) {
        return db;
    }
    try {
        // Wait for the client to connect to the server.
        await client.connect();
        console.log("Successfully connected to MongoDB.");
        
        // Get the database instance. If your URI includes the db name, 
        // client.db() will use it. Otherwise, it uses the default 'test' db.
        db = client.db(); 
        
        return db;
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
        // Exit the entire application process if the database connection fails.
        // This is a critical failure.
        process.exit(1); 
    }
}

// Export the connectDB function and a getter for the database instance.
module.exports = {
    connectDB,
    /**
     * Retrieves the database instance.
     * Throws an error if the database is not initialized.
     * @returns {Db} The database instance.
     */
    getDb: () => {
        if (!db) {
            throw new Error("Database not initialized. Call connectDB first.");
        }
        return db;
    }
};
