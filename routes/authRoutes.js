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
            'https://www.googleapis.com/auth/spreadsheets.readonly',
            'https://www.googleapis.com/auth/script.projects',
            'https://www.googleapis.com/auth/script.external_request',
            'https://www.googleapis.com/auth/script.scriptapp'
        ],
        prompt: 'consent', 
        state
    });

    res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;

  
    if (!code) {
        console.error("OAuth Callback Error: 'code' parameter is missing from Google's response.");
        return res.status(400).send("Authorization code is missing. Please try authenticating again.");
    }
    if (!state) {
        console.error("OAuth Callback Error: 'state' parameter is missing from Google's response.");
        return res.status(400).send("State parameter is missing. Please try connecting again.");
    }

    let decodedState;
    try {
        // req.query should already be URL-decoded by Express
        decodedState = JSON.parse(state);
    } catch (err) {
        console.error("OAuth Callback Error: Failed to parse state parameter.", { state, error: err });
        return res.status(400).send("Invalid state parameter format.");
    }

    const { spreadsheetId, range } = decodedState;

    if (!spreadsheetId || !range) {
        return res.status(400).send("Spreadsheet ID or Sheet Name was missing from the state. Please go back and enter them.");
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI // This MUST exactly match the one in your Google Cloud Console
    );

    try {
        // 2. Exchange authorization code for tokens
        console.log("Exchanging authorization code for tokens...");
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        console.log("Successfully retrieved OAuth tokens.");

        // === STEP 1: Read Google Sheet ===
        console.log(`Reading data from spreadsheet: ${spreadsheetId}, range: ${range}`);
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        const sheetResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = sheetResponse.data.values;

        if (!rows || rows.length === 0) {
            return res.send('No data found in the specified sheet and range.');
        }
        console.log(`Found ${rows.length} rows in the sheet.`);

        const headers = rows[0];
        const dataRows = rows.slice(1);

        const formattedData = dataRows.map((row,index) => {
            const input_data = {};
            headers.forEach((header, i) => {
                const key = header?.toString().trim() || `coloumn _${i}`;
                if(key){
                  input_data[key] = row[i] || null;
                }
          
            });
            return {
             spreadsheet_id: spreadsheetId,
             sheet_range: range,
             row_index: index + 2, // Sheets are 1-based, and headers are row 1
             project_identifier: input_data["Project"] || "Unnamed Project",
              sync_timestamp: new Date().toISOString(),
             input_data
            };
        });

        // Validate and send to SQS
        bulkImportSchema.parse({ data: formattedData });
        await sendBulkImportMessages(formattedData);
        console.log("Successfully validated and sent data to SQS.");

        // === STEP 3: Create & inject Apps Script ===
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
            timeZone: 'Asia/Kolkata',   // change the timzone accordingly 
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

        console.log("Injecting secret token into Apps Script...");
        await script.scripts.run({
            scriptId,
            requestBody: {
                function: 'setSecretTokenFromBackend',
                parameters: [API_SECRET_TOKEN,API_BASE_URL]
            }
        });
        console.log("Secret token injected.");

        console.log("Creating onEdit trigger...");
        await script.scripts.run({
            scriptId,
            requestBody: { function: 'createTrigger' }
        });
        console.log("onEdit trigger installed.");

        return res.send("✅ Success! Your Google Sheet is now connected. Data has been synced, and an edit trigger has been installed to keep it up-to-date.");

    } catch (err) {
        // Log the detailed error from the Google API client for better debugging
        console.error("Detailed OAuth callback error:", err.response ? JSON.stringify(err.response.data, null, 2) : err.message);

        // Check for the most common error and provide a helpful response
        if (err.response && err.response.data && err.response.data.error === 'redirect_uri_mismatch') {
            return res.status(500).send(`
                <div style="font-family: sans-serif; padding: 20px;">
                    <h1>Error: Redirect URI Mismatch</h1>
                    <p>The redirect URI sent with the authentication request does not match the ones you've configured in the Google Cloud Console. This is a common setup issue.</p>
                    <p><b>The URI your application is using:</b></p>
                    <code style="background: #eee; padding: 5px; border-radius: 4px;">${GOOGLE_REDIRECT_URI}</code>
                    <p><b>What to do:</b></p>
                    <ol>
                        <li>Go to the <a href="https://console.cloud.google.com/apis/credentials">Google Cloud Console Credentials page</a>.</li>
                        <li>Select your OAuth 2.0 Client ID.</li>
                        <li>Under "Authorized redirect URIs", click "ADD URI".</li>
                        <li>Paste the exact URI shown above and save your changes.</li>
                    </ol>
                </div>
            `);
        }

        return res.status(500).send(" An error occurred. Failed to process the Google Sheet or deploy the script. Please check the server logs for detailed information.");
    }
});

module.exports = router;
