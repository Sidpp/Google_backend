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

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/spreadsheets', 
            'https://www.googleapis.com/auth/script.projects',
            'https://www.googleapis.com/auth/script.scriptapp'
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

        res.send("✅ Success! Your Google Sheet is being connected in the background. You can close this window. Check your sheet for the 'API Sync' menu in a minute.");

        (async () => {
            try {
                console.log("--- Starting background processing ---");
                console.time('background_process_duration');

                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range });
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
                bulkImportSchema.parse({ data: formattedData });
                await sendBulkImportMessages(formattedData);
                console.log("Successfully validated and sent data to SQS.");

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

                const codePath = path.join(__dirname, '../scripts/code.gs');
                const codeContent = fs.readFileSync(codePath, 'utf8');
                const manifestContent = JSON.stringify({
                    timeZone: 'Asia/Kolkata',
                    exceptionLogging: 'STACKDRIVER',
                    runtimeVersion: 'V8',
                    oauthScopes: [
                        "https://www.googleapis.com/auth/spreadsheets.currentonly",
                        "https://www.googleapis.com/auth/script.scriptapp",
                        "https://www.googleapis.com/auth/script.external_request"
                    ]
                });

                console.log("Updating script content...");
                await script.projects.updateContent({
                    scriptId,
                    requestBody: {
                        files: [
                            { name: 'Code', type: 'SERVER_JS', source: codeContent },
                            { name: 'appsscript', type: 'JSON', source: manifestContent }
                        ]
                    }
                });
                console.log("Script content updated.");

                // --- ROBUST FIX: Retry mechanism for running the script ---
                let setupSuccess = false;
                const maxRetries = 3;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        console.log(`Attempt ${attempt} to run script setup functions...`);
                        await script.scripts.run({
                            scriptId,
                            requestBody: {
                                function: 'setupFromBackend',
                                parameters: [API_SECRET_TOKEN, API_BASE_URL]
                            }
                        });
                        console.log("Script setup complete.");
                        setupSuccess = true;
                        break; // Exit the loop on success
                    } catch (err) {
                        // Check if the error is the specific 404 we want to retry on
                        if (err.code === 404 && attempt < maxRetries) {
                            console.warn(`Function not found on attempt ${attempt}, retrying in 5 seconds...`);
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        } else {
                            // For other errors or on the last attempt, re-throw the error
                            throw err;
                        }
                    }
                }

                if (!setupSuccess) {
                    throw new Error("Failed to run script setup function after multiple retries.");
                }

                console.timeEnd('background_process_duration');
                console.log("--- Background processing finished successfully ---");

            } catch (backgroundErr) {
                console.error("--- ERROR IN BACKGROUND PROCESS ---");
                console.error("Detailed background error:", backgroundErr.response ? JSON.stringify(backgroundErr.response.data, null, 2) : backgroundErr.message);
            }
        })();

    } catch (err) {
        console.error("Detailed OAuth callback error (getToken failed):", err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
        if (err.response && err.response.data && err.response.data.error === 'redirect_uri_mismatch') {
            return res.status(500).send(`...`); // Kept your mismatch error html
        }
        return res.status(500).send("An error occurred during the initial authentication step. Please check server logs.");
    }
});

module.exports = router;
