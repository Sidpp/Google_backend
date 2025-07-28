const mongoose = require("mongoose");

const googleCredentialSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "GoogleUser", // Assuming you have a User model named 'GoogleUser'
            required: true,
        },
        spreadsheetId: {
            type: String,
            required: true,
        },
        sheetRange: {
            type: String,
            required: true,
        },
        googleTokens: {
            type: Object,
            required: true,
        },
        rows: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "GoogleSheetData", 
            },
        ],
        status: {
            type: String,
    enum: ['processing', 'completed', 'failed'],
 default: 'processing',
        },
        error: {
            type: String,
            required: false, 
        },
      },
    { timestamps: true }
);
module.exports = mongoose.model("GoogleCredential", googleCredentialSchema);
