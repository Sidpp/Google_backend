const express = require('express');
const { google } = require('googleapis');
// const { sendBulkImportMessages } = require('../sqs-service'); // Commented out for test
// const { bulkImportSchema } = require('../utils/validator'); // Commented out for test
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

        res.redirect("https://mnr-pmo-vue.vercel.app/dashboard/settings/profile");

        (async () => {
            try {
                console.log("--- Starting background processing (DIAGNOSTIC MODE) ---");
                
                const script = google.script({ version: 'v1', auth: oauth2Client });
                
                console.log("Creating new Apps Script project and binding it to the sheet...");
                const { data: project } = await script.projects.create({
                    requestBody: { 
                        title: `DIAGNOSTIC TEST - ${spreadsheetId}`,
                        parentId: spreadsheetId
                    }
                });
                const scriptId = project.scriptId;
                console.log(`Apps Script project created with ID: ${scriptId}`);

                console.log("Preparing and updating with simple test script...");
                const simpleCode = `function testFunction(param1) { Logger.log('Test function executed successfully with parameter: ' + param1); return 'Hello from Apps Script!'; }`;
                const manifestContent = JSON.stringify({
                    timeZone: 'Asia/Kolkata',
                    exceptionLogging: 'STACKDRIVER',
                    runtimeVersion: 'V8'
                });

                await script.projects.updateContent({
                    scriptId,
                    requestBody: {
                        files: [
                            { name: 'Code', type: 'SERVER_JS', source: simpleCode },
                            { name: 'appsscript', type: 'JSON', source: manifestContent }
                        ]
                    }
                });
                console.log("Simple script content updated.");

                let setupSuccess = false;
                const maxRetries = 3;
                const retryDelay = 5000;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        console.log(`Attempt ${attempt} to run TEST function...`);
                        if (attempt > 1) {
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                        }
                        
                        const runResponse = await script.scripts.run({
                            scriptId,
                            requestBody: {
                                function: 'testFunction',
                                parameters: ["It worked!"]
                            }
                        });

                        console.log("TEST function ran successfully!");
                        console.log("Response from script:", runResponse.data);
                        setupSuccess = true;
                        break; 
                    } catch (err) {
                        if (err.code === 404 && attempt < maxRetries) {
                            console.warn(`TEST function not found on attempt ${attempt}, retrying...`);
                        } else {
                            throw err;
                        }
                    }
                }

                if (!setupSuccess) {
                    throw new Error("Failed to run TEST function after multiple retries.");
                }

                console.log("--- DIAGNOSTIC TEST SUCCEEDED ---");

            } catch (backgroundErr) {
                console.error("--- ERROR IN DIAGNOSTIC BACKGROUND PROCESS ---");
                console.error("Detailed background error:", backgroundErr.response ? JSON.stringify(backgroundErr.response.data, null, 2) : backgroundErr.message);
            }
        })();

    } catch (err) {
        console.error("Detailed OAuth callback error (getToken failed):", err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
        return res.status(500).send("An error occurred during the initial authentication step. Please check server logs.");
    }
});

module.exports = router;
