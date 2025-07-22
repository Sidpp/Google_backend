const mongoose = require("mongoose");

// It's good practice to rename this to userSchema
const userSchema = new mongoose.Schema(
  {
    // ... all your fields like name, email, password, etc.
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["Admin", "User"], required: true },
    jira_credential_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JiraCredential",
    },
    // The field to add the ID to
    google_credential_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoogleCredential", 
    },
    // ... other fields
  },
  { timestamps: true } 
);

// --- THIS IS THE MOST IMPORTANT CHANGE ---
// Naming the model 'User' tells Mongoose to use the 'users' collection.
module.exports = mongoose.model("User", userSchema);