const express = require('express');
const { google } = require('googleapis');
const { sendBulkImportMessages } = require('../sqs-service');
const { bulkImportSchema } = require('../utils/validator'); 
const path = require('path');
const fs = require('fs');
const router = express.Router();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, API_SECRET_TOKEN, API_BASE_URL} = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !API_SECRET_TOKEN || !API_BASE_URL) {
    console.error("FATAL ERROR: Missing required Google OAuth or API Secret environment variables.");
    process.exit(1); 
}

router.get('/google', (req, res) => {
    const { state } = req.query;
    
    if (!state || state === "{}") {
        return res.status(400).send("State is missing or empty. Please provide spreadsheet details on the previous page.");
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );

    // ✅ FIXED: Consistent scopes with Apps Script manifest
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/script.projects',
            'https://www.googleapis.com/auth/script.scriptapp',
            'https://www.googleapis.com/auth/script.external_request',
            'https://www.googleapis.com/auth/drive'
        ],
        prompt: 'consent', 
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
        decodedState = JSON.parse(state);
    } catch (err) {
        return res.status(400).send("Invalid state parameter format.");
    }
    
    const { sheetId, sheetRange } = decodedState;

    if (!sheetId || !sheetRange) {
        return res.status(400).send("Spreadsheet ID or Sheet Name was missing from the state. Please go back and enter them.");
    }
    
    const spreadsheetId = sheetId;
    const range = `${sheetRange}!A1:AZ1000`;

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI 
    );

    try {
        console.log("Exchanging authorization code for tokens...");
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        console.log("Successfully retrieved OAuth tokens.");

        // ✅ FIXED: Redirect immediately and handle background processing
        res.redirect("https://mnr-pmo-vue.vercel.app/dashboard/settings/profile");

        // Background processing with improved error handling
        setImmediate(async () => {
            try {
                console.log("--- Starting background processing ---");
                console.time('background_process_duration');

                // Step 1: Read and process spreadsheet data
                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await sheets.spreadsheets.values.get({ 
                    spreadsheetId, 
                    range 
                });
                const rows = sheetResponse.data.values;

                if (!rows || rows.length === 0) {
                    console.log('No data found in the sheet. Background process finished.');
                    return;
                }
                console.log(`Found ${rows.length} rows in the sheet.`);

                const headers = rows[0];
                const dataRows = rows.slice(1);
                const formattedData = dataRows.map((row, index) => {
                    const input_data = {};
                    headers.forEach((header, i) => {
                        const key = header?.toString().trim() || `column_${i}`;
                        if (key) {
                            input_data[key] = row[i] || null;
                        }
                    });
                    return {
                        spreadsheet_id: spreadsheetId,
                        sheet_range: range,
                        row_index: index + 2,
                        project_identifier: input_data["Project"] || "Unnamed Project",
                        sync_timestamp: new Date().toISOString(),
                        input_data
                    };
                });

                // Step 2: Validate and send to SQS
                bulkImportSchema.parse({ data: formattedData });
                await sendBulkImportMessages(formattedData);
                console.log("Successfully validated and sent data to SQS.");

                // Step 3: Create and configure Apps Script
                const script = google.script({ version: 'v1', auth: oauth2Client });
                
                console.log("Creating new Apps Script project and binding it to the sheet...");
                const { data: project } = await script.projects.create({
                    requestBody: { 
                        title: `Sheet AI Sync - ${spreadsheetId}`,
                        parentId: spreadsheetId
                    }
                });
                const scriptId = project.scriptId;
                console.log(`Apps Script project created with ID: ${scriptId}`);

                // Step 4: Prepare script content
                console.log("Preparing and updating script content...");
                const codePath = path.join(__dirname, '../scripts/code.gs');
                const codeContent = fs.readFileSync(codePath, 'utf8');
                
                // ✅ FIXED: Updated manifest with consistent scopes
                const manifestContent = JSON.stringify({
                    timeZone: 'Asia/Kolkata',
                    exceptionLogging: 'STACKDRIVER',
                    runtimeVersion: 'V8',
                    executionApi: {
                        access: 'ANYONE'
                    },
                    oauthScopes: [
                        "https://www.googleapis.com/auth/spreadsheets",
                        "https://www.googleapis.com/auth/script.scriptapp",
                        "https://www.googleapis.com/auth/script.external_request"
                    ]
                }, null, 2);

                await script.projects.updateContent({
                    scriptId,
                    requestBody: {
                        files: [
                            { name: 'Code', type: 'SERVER_JS', source: codeContent },
                            { name: 'appsscript', type: 'JSON', source: manifestContent }
                        ]
                    }
                });
                console.log("Script content updated successfully.");

                // ✅ FIXED: Improved retry mechanism with exponential backoff
                let setupSuccess = false;
                const maxRetries = 8;
                const baseDelay = 5000; // 5 seconds

                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        if (attempt > 1) {
                            const delay = baseDelay * Math.pow(2, attempt - 2); // Exponential backoff
                            console.log(`Attempt ${attempt}/${maxRetries}: Waiting ${delay/1000}s before retry...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }

                        console.log(`Attempting to run setupFromBackend function (attempt ${attempt}/${maxRetries})`);
                        
                        const runResult = await script.scripts.run({
                            scriptId,
                            requestBody: {
                                function: 'setupFromBackend',
                                parameters: [API_SECRET_TOKEN, API_BASE_URL],
                                devMode: false // Use deployed version for better stability
                            }
                        });

                        console.log("Script setup completed successfully:", runResult.data);
                        setupSuccess = true;
                        break;
                        
                    } catch (err) {
                        console.warn(`Attempt ${attempt} failed:`, err.message);
                        
                        if (attempt === maxRetries) {
                            throw new Error(`Failed to run script setup after ${maxRetries} attempts. Last error: ${err.message}`);
                        }

                        // Check if it's a temporary error worth retrying
                        if (err.response?.status === 404 || 
                            err.response?.status === 403 || 
                            err.message.includes('not found') ||
                            err.message.includes('temporarily unavailable')) {
                            continue; // Retry
                        } else {
                            throw err; // Don't retry for other errors
                        }
                    }
                }

                if (!setupSuccess) {
                    throw new Error("Script setup failed after all retry attempts.");
                }

                console.timeEnd('background_process_duration');
                console.log("--- Background processing completed successfully ---");

            } catch (backgroundErr) {
                console.error("--- ERROR IN BACKGROUND PROCESS ---");
                console.error("Error details:", {
                    message: backgroundErr.message,
                    stack: backgroundErr.stack,
                    response: backgroundErr.response ? {
                        status: backgroundErr.response.status,
                        data: backgroundErr.response.data
                    } : null
                });
                
                // Optionally, you could implement a notification system here
                // to alert about background processing failures
            }
        });

    } catch (err) {
        console.error("OAuth callback error:", err);
        
        if (err.response?.data?.error === 'redirect_uri_mismatch') {
            return res.status(500).send(`
                <h1>OAuth Configuration Error</h1>
                <p>The redirect URI doesn't match what's configured in Google Cloud Console.</p>
                <p>Please check your OAuth configuration.</p>
            `);
        }
        
        return res.status(500).send(`
            <h1>Authentication Error</h1>
            <p>An error occurred during authentication. Please try again.</p>
            <p>If the problem persists, please contact support.</p>
        `);
    }
});

module.exports = router;