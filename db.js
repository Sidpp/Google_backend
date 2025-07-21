// =================================================================
// Corrected Database File (db.js)
// Use this code to replace the contents of your existing db.js
// =================================================================
const mongoose = require('mongoose');

// This function connects to the database using Mongoose.
const connectDB = async () => {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
        // Throw a clear error if the connection string is missing.
        throw new Error("MONGODB_URI is not defined in environment variables. Server cannot start.");
    }
    
    try {
        // Use mongoose.connect() which is the required method for Mongoose apps.
        // It manages the connection pool for your entire application.
        await mongoose.connect(uri, {
            // These options are recommended for modern Mongoose versions
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log("Successfully connected to MongoDB using Mongoose.");
    } catch (error) {
        console.error("Failed to connect to MongoDB using Mongoose.", error);
        // Re-throw the error to be caught by startServer() in index.js
        throw error;
    }
};

module.exports = { connectDB };
