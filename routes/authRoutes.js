//SEE THE NOTEPAD FILE 


const express = require('express');
const { google } = require('googleapis');
const { sendBulkImportMessages } = require('../sqs-service'); 
const router = express.Router();
const User = require('../models/GoogleUsers');
const GoogleCredential = require('../models/GoogleCredential');
const { scriptContent } = require('../scripts/script_content.js');
const fetch = require('node-fetch');
const { URL } = require('url');


const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, API_SECRET_TOKEN, API_BASE_URL } = process.env;

// A single check at startup is a good practice.
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !API_SECRET_TOKEN || !API_BASE_URL) {
    console.error("FATAL ERROR: Missing required Google OAuth or API Secret environment variables.");
    process.exit(1); 
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// This function is still useful to ensure the project exists before we update it.
const waitForScriptReady = async (script, scriptId, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await script.projects.get({ scriptId });
            console.log(`Script project ${scriptId} is ready after ${i + 1} attempts`);
            return true;
        } catch (error) {
            console.log(`Script not ready, attempt ${i + 1}/${maxRetries}. Waiting...`);
            await delay(2000 * (i + 1));
        }
    }
    throw new Error(`Script project ${scriptId} not ready after ${maxRetries} attempts`);
};

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
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/script.projects',
            'https://www.googleapis.com/auth/script.scriptapp',
            'https://www.googleapis.com/auth/script.external_request',
            'https://www.googleapis.com/auth/script.deployments',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file'
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

        await User.findByIdAndUpdate(userId, {
            $set: { google_credential_id: connectionId }
        });

        res.redirect("https://mnr-pmo-vue.vercel.app/dashboard/settings/profile?status=processing");

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

                const formattedData = dataRows.map((row, index) => {
                    const input_data = {};
                    headers.forEach((header, i) => {
                        const key = header?.toString().trim() || `column_${i}`;
                        if (key) {
                            input_data[key] = row[i] || null;
                        }
                    });

                    return {
                        connectionId: connectionId.toString(),
                        userId: userId,
                        spreadsheet_id: spreadsheetId,
                        sheet_range: range,
                        row_index: index + 2,
                        project_identifier: input_data["Project"] || "Unnamed Project",
                        sync_timestamp: new Date().toISOString(),
                        input_data
                    };
                });

                // Step 2: Validate and send to SQS for bulk import
                await sendBulkImportMessages(formattedData);
                console.log(`Successfully sent ${formattedData.length} messages to SQS for user ${userId}.`);

                // ===================================================================================
                //
                // +++ CHANGE 2: The entire Apps Script setup logic is replaced with this reliable method +++
                //
                // ===================================================================================

                const script = google.script({ version: 'v1', auth: oauth2Client });
                console.log("Setting up Apps Script by deploying as a web app...");

                // STEP A: Create a new Apps Script project bound to the spreadsheet
                const createResponse = await script.projects.create({
                    requestBody: {
                        title: `PPPVue Data Sync (WebApp) for Sheet ${new Date().toISOString().slice(0, 10)}`,
                        parentId: spreadsheetId 
                    }
                });
                const scriptId = createResponse.data.scriptId;
                console.log(`Created new Apps Script project with ID: ${scriptId}`);
                await waitForScriptReady(script, scriptId); // Wait for project to be accessible

                // STEP B: Update the script content AND the manifest in one go.
                // The new manifest includes the 'webapp' configuration needed to make the script a web app.
                await script.projects.updateContent({
                    scriptId: scriptId,
                    requestBody: {
                        files: [
                            {
                                name: 'Code',
                                type: 'SERVER_JS',
                                source: scriptContent // This uses the code from your script_content_updated artifact
                            },
                            {
                                 name: 'appsscript',
                                type: 'JSON',
                                source: JSON.stringify({
                                    "timeZone": "America/New_York",
                                    "dependencies": {},
                                    "exceptionLogging": "STACKDRIVER",
                                    "runtimeVersion": "V8",
                                    "webapp": {
                                        "access": "ANYONE_ANONYMOUS",
                                        "executeAs": "USER_ACCESSING"
                                    },
                                    "oauthScopes": [
                                        "https://www.googleapis.com/auth/spreadsheets",
                                        "https://www.googleapis.com/auth/script.scriptapp",
                                        "https://www.googleapis.com/auth/script.external_request"
                                    ]
                                })
                            }
                        ]
                    }
                });
                console.log(`Successfully updated script content and manifest.`);
                await delay(10000); // Allow time for content to propagate before deploying.

                // STEP C: Deploy the script as a web app
                const deployment = await script.projects.deployments.create({
                    scriptId: scriptId,
                    requestBody: {
                        versionNumber: 1,
                        description: 'Initial deployment for backend setup'
                    }
                });
                const deploymentId = deployment.data.deploymentId;
                const deploymentConfig = await script.projects.deployments.get({
                    scriptId,
                    deploymentId
                });
                const webAppUrl = deploymentConfig.data.entryPoints.find(e => e.type === 'WEB_APP').webApp.url;
                console.log(`Successfully deployed script as web app. URL: ${webAppUrl}`);
                await delay(5000); // Allow time for deployment to become active.

                // STEP D: Call the web app URL to trigger the setup function inside the script.
                // This is the most reliable way to execute the script's setup logic.
                const setupUrl = new URL(webAppUrl);
                setupUrl.searchParams.append('secret', API_SECRET_TOKEN);
                setupUrl.searchParams.append('backendApiUrl', API_BASE_URL);
                setupUrl.searchParams.append('userId', userId);
                // This is the crucial part to ensure the script knows which connection it belongs to.
                setupUrl.searchParams.append('connectionId', connectionId.toString());

                console.log('Calling script setup URL to trigger self-configuration...');
                const setupResponse = await fetch(setupUrl.href, { method: 'GET' });
                const setupResult = await setupResponse.json();

                // Check if the script's setup function reported success.
                if (!setupResponse.ok || !setupResult.success) {
                    throw new Error(`Failed to set up Apps Script trigger via web app. Reason: ${setupResult.message || 'Unknown error'}`);
                }

                console.log('Apps Script self-setup completed successfully via web app call.');
                console.log(`--- Background processing completed successfully for user: ${userId} ---`);

            } catch (backgroundErr) {
                console.error(`--- ERROR IN BACKGROUND PROCESS for user ${userId} ---`);
                if (backgroundErr.code === 403) {
                    console.error(`PERMISSION DENIED: The authenticated user does not have access to sheet ${spreadsheetId}.`);
                } else if (backgroundErr.message?.includes('Requested entity was not found')) {
                    console.error('APPS SCRIPT ERROR: Script project not found or not accessible. This could be due to:');
                    console.error('1. API propagation delay');
                    console.error('2. Insufficient permissions');
                    console.error('3. Script project creation failure');
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
        if (err.response?.data?.error === 'redirect_uri_mismatch') {
            return res.status(500).send("<h1>OAuth Configuration Error</h1><p>The redirect URI is misconfigured. Please contact support.</p>");
        }
        return res.status(500).send("<h1>Authentication Error</h1><p>An error occurred during authentication. Please try again.</p>");
    }
});

module.exports = router;
