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
    
    // --- FIX: Use the correct keys from the state object ---
    const { sheetId, sheetRange } = decodedState;

    if (!sheetId || !sheetRange) {
        return res.status(400).send("Spreadsheet ID or Sheet Name was missing from the state. Please go back and enter them.");
    }
    
    // --- FIX: Reconstruct the full range string for the API ---
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

        // Immediately send a response to the user to avoid a timeout.
        
     res.send(`
     <html>
    <head>
      <title>Success - Redirecting...</title>
      <meta http-equiv="refresh" content="3;url=https://mnr-pmo-vue.vercel.app/dashboard/settings/profile" />
    </head>
    <body>
      <h2>✅ Success!</h2>
      <p>Your Google Sheet is being connected in the background.</p>
   </body>
    </html>`);

        // Start the long-running process in the background.
        (async () => {
            try {
                console.log("--- Starting background processing ---");
                console.time('background_process_duration');

                // STEP 1: Read Google Sheet
                console.log(`Reading data from spreadsheet: ${spreadsheetId}, range: ${range}`);
                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range });
                const rows = sheetResponse.data.values;

                if (!rows || rows.length === 0) {
                    console.log('No data found in the sheet. Background process finished.');
                    return;
                }
                console.log(`Found ${rows.length} rows in the sheet.`);

                // STEP 2: Process data and send to SQS
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

                // STEP 3: Create & inject Apps Script
                const script = google.script({ version: 'v1', auth: oauth2Client });
                console.log("Creating new Apps Script project...");
                const { data: project } = await script.projects.create({
                    requestBody: { title: `Sheet AI Sync - ${spreadsheetId}` }
                });
                const scriptId = project.scriptId;
                console.log(`Apps Script project created with ID: ${scriptId}`);

                const codePath = path.join(__dirname, '../scripts/code.gs');
                const codeContent = fs.readFileSync(codePath, 'utf8');
                const manifestContent = JSON.stringify({
                    timeZone: 'Asia/Kolkata',
                    exceptionLogging: 'STACKDRIVER',
                    runtimeVersion: 'V8',
                    executionApi: { access: 'ANYONE' }
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

                console.log("Running script setup functions...");
                await script.scripts.run({
                    scriptId,
                    requestBody: {
                        function: 'setupFromBackend',
                        parameters: [API_SECRET_TOKEN, API_BASE_URL]
                    }
                });
                console.log("Script setup complete.");
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
