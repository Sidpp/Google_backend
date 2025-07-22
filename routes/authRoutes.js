const express = require('express');
const { google } = require('googleapis');
// Make sure to import your SQS service and validation schemas correctly
const { sendBulkImportMessages } = require('../sqs-service'); 
const { bulkImportSchema } = require('../utils/validator'); 
const router = express.Router();
const User = require('../models/GoogleUsers');
const GoogleCredential = require('../models/GoogleCredential');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, API_SECRET_TOKEN, API_BASE_URL } = process.env;

// A single check at startup is a good practice.
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !API_SECRET_TOKEN || !API_BASE_URL) {
    console.error("FATAL ERROR: Missing required Google OAuth or API Secret environment variables.");
    process.exit(1); 
}

// =================================================================
// ROUTE: /auth/google
// Initiates the Google OAuth flow.
// =================================================================
router.get('/google', (req, res) => {
    const { state } = req.query;
    
    // The state, passed from your frontend, should contain { userId, sheetId, sheetRange }
    if (!state || state === "{}") {
        return res.status(400).send("State is missing or empty. Please provide spreadsheet details on the previous page.");
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // 'offline' is crucial for getting a refresh_token
        scope: [
            // ARCHITECTURAL SUGGESTION: Keep scopes minimal. 'userinfo.email' is not strictly
            // needed if you only verify access by trying to read the sheet, but it's useful for logging.
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/script.projects',
            'https://www.googleapis.com/auth/script.scriptapp',
            'https://www.googleapis.com/auth/script.external_request',
            'https://www.googleapis.com/auth/drive'
        ],
        prompt: 'consent', // 'consent' forces the user to see the consent screen every time. 
                            // This is good for development but for production, you might remove it
                            // so returning users don't have to re-consent if they have a valid refresh token.
        state
    });
    
    res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return res.status(400).send("Authorization code or state is missing. Please try again.");
    }

    let decodedState;
    try {
        decodedState = JSON.parse(decodeURIComponent(state));
    } catch (err) {
        return res.status(400).send("Invalid state parameter format.");
    }
    
    const { sheetId, sheetRange, userId } = decodedState;

    if (!sheetId || !sheetRange || !userId) {
        return res.status(400).send("Spreadsheet ID, Sheet Range, or User ID was missing from the state. Please ensure you are logged in and have provided all fields.");
    }
    
    const spreadsheetId = sheetId;
    const range = `${sheetRange}!A1:AZ1000`;

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI,
    );

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        console.log("Successfully retrieved OAuth tokens.");


        const newConnection = await GoogleCredential.create({
            userId: userId, 
            spreadsheetId: spreadsheetId,
            sheetRange: sheetRange,
            googleTokens: tokens,
            rows: []
        });
        const connectionId = newConnection._id;
        console.log(`Created new Google credential with ID: ${connectionId}`);
        
        // --- FIX: Use the correct variable 'GoogleUsers' which was imported at the top ---
        await User.findByIdAndUpdate(userId, {
            $set: { google_credential_id: connectionId }
        });

        res.redirect("https://mnr-pmo-vue.vercel.app/dashboard/settings/profile?status=processing");

        // --- BACKGROUND PROCESSING ---
        // `setImmediate` is okay, but for a high-load system, consider a more robust job queue worker.
        setImmediate(async () => {
            try {
                console.log(`--- Starting background processing for user: ${userId} ---`);
                console.time(`background_process_duration_${userId}`);

                // Step 1: Read spreadsheet data (this also implicitly verifies permission)
                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range });
                const rows = sheetResponse.data.values;

                if (!rows || rows.length <= 1) { // Check for header-only sheets
                    console.log(`No data rows found in the sheet for user ${userId}. Process finished.`);
                    return;
                }
                console.log(`Found ${rows.length - 1} data rows in the sheet.`);

                const headers = rows[0];
                const dataRows = rows.slice(1);
                
                // The `userId` is now added to every single message payload. 
                const formattedData = dataRows.map((row, index) => {
                    const input_data = {};
                    headers.forEach((header, i) => {
                        const key = header?.toString().trim() || `column_${i}`;
                        if (key) {
                            input_data[key] = row[i] || null;
                        }
                    });
                    
                    // This is the object that will be sent to SQS for the Lambda to process.
                    return {
                        connectionId:connectionId.toString(),
                        userId: userId, // <-- The user's ID is now part of the message.
                        spreadsheet_id: spreadsheetId,
                        sheet_range: range,
                        row_index: index + 2,
                        project_identifier: input_data["Project"] || "Unnamed Project",
                        sync_timestamp: new Date().toISOString(),
                        input_data
                    };
                });

                // Step 2: Validate and send to SQS
                await sendBulkImportMessages(formattedData);
                console.log(`Successfully sent ${formattedData.length} messages to SQS for user ${userId}.`);

                // Step 3 & 4: Apps Script Creation (Placeholder for future logic)
                console.log("Apps Script processing would start here...");


                console.timeEnd(`background_process_duration_${userId}`);
                console.log(`--- Background processing completed successfully for user: ${userId} ---`);

            } catch (backgroundErr) {
                console.error(`--- ERROR IN BACKGROUND PROCESS for user ${userId} ---`);
                if (backgroundErr.code === 403) {
                    console.error(`PERMISSION DENIED: The authenticated user does not have access to sheet ${spreadsheetId}.`);
                } else {
                    console.error("An unexpected error occurred:", {
                        message: backgroundErr.message,
                        stack: backgroundErr.stack,
                    });
                }
            }
        });

    } catch (err) {
        console.error("OAuth callback error:", err);
        // Provide more informative error pages if possible.
        if (err.response?.data?.error === 'redirect_uri_mismatch') {
            return res.status(500).send("<h1>OAuth Configuration Error</h1><p>The redirect URI is misconfigured. Please contact support.</p>");
        }
        return res.status(500).send("<h1>Authentication Error</h1><p>An error occurred during authentication. Please try again.</p>");
    }
});

module.exports = router;
