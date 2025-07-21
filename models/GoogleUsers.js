const mongoose = require("mongoose");
const googleUserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["Admin", "User"],
      required: true,
    },
    image: {
      type: String,
    },
    token: {
      type: String,
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
    resetPasswordExpires: {
      type: Date,
    },
    jira_credential_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JiraCredential",
    },

    google_credential_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoogleCredential", 
    },
  },
  { timestamps: true } 
);

module.exports = mongoose.model("GoogleUser", googleUserSchema);
