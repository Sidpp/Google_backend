const mongoose = require('mongoose');
const connectDB = async () => {
const uri = process.env.MONGODB_URI;

if (!uri) {

throw new Error("MONGODB_URI is not defined in environment variables. Server cannot start.");
}

try {
await mongoose.connect(uri, {
useNewUrlParser: true,
useUnifiedTopology: true,
});
console.log("Successfully connected to MongoDB using Mongoose.");
} catch (error) {
console.error("Failed to connect to MongoDB using Mongoose.", error);
throw error;
}
};

module.exports = { connectDB };
