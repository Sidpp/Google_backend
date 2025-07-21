const { MongoClient } = require('mongodb');
const uri = process.env.MONGO_URI;
if (!uri) {
    throw new Error('Please define the MONGO_URI environment variable inside .env');
}

const client = new MongoClient(uri);
let db;

async function connectDB() {
    if (db) {
        return db;
    }
    try {
        await client.connect();
        console.log("Successfully connected to MongoDB.");
        db = client.db(); // This will connect to the 'PPPVue' database specified in your URI
        return db;
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
        process.exit(1); // Exit the process if DB connection fails
    }
}

// Export the db instance directly for use in other files
module.exports = {
    connectDB,
    getDb: () => {
        if (!db) {
            throw new Error("Database not initialized. Call connectDB first.");
        }
        return db;
    }
};