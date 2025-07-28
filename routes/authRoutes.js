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

                // Step 1: Read spreadsheet data
                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range });
                const rows = sheetResponse.data.values;

                if (!rows || rows.length <= 1) {
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

                // Step 2: Send to SQS
                await sendBulkImportMessages(formattedData);
                console.log(`Successfully sent ${formattedData.length} messages to SQS for user ${userId}.`);

        
            //APP SCRIPT SETUP 

               const script = google.script({ version: 'v1', auth: oauth2Client });
                console.log("[DEBUG] Setting up Apps Script...");

                // STEP A: Create an EMPTY Apps Script project. This is required by the API.
                const createRequest = {
                    title: `PPPVue Data Sync (Verified) ${new Date().toISOString()}`,
                    parentId: spreadsheetId 
                };
                console.log('[DEBUG] STEP A: Creating project with request:', JSON.stringify(createRequest, null, 2));
                const createResponse = await script.projects.create({ requestBody: createRequest });
                const scriptId = createResponse.data.scriptId;
                console.log(`[SUCCESS] Created new EMPTY Apps Script project with ID: ${scriptId}`);
                await waitForScriptReady(script, scriptId);

                // STEP B: Update the empty project with the full script and manifest files.
                const updateRequest = {
                    files: [
                        { name: 'Code', type: 'SERVER_JS', source: scriptContent },
                        {
                            name: 'appsscript', // The name must be 'appsscript'
                            type: 'JSON',
                            source: JSON.stringify({
                                "timeZone": "America/New_York", "dependencies": {}, "exceptionLogging": "STACKDRIVER", "runtimeVersion": "V8",
                                "webapp": { "access": "ANYONE_ANONYMOUS", "executeAs": "USER_ACCESSING" },
                                "oauthScopes": [
                                    "https://www.googleapis.com/auth/spreadsheets",
                                    "https://www.googleapis.com/auth/script.scriptapp",
                                    "https://www.googleapis.com/auth/script.external_request"
                                ]
                            })
                        }
                    ]
                };
                console.log(`[DEBUG] STEP B: Updating project ${scriptId} with content...`);
                await script.projects.updateContent({ scriptId: scriptId, requestBody: updateRequest });
                console.log('[SUCCESS] Sent update for script content and manifest.');

                // STEP C: VERIFY that the manifest file has been saved before deploying. This prevents the race condition.
                console.log('[DEBUG] STEP C: Starting verification loop...');
                let manifestExists = false;
                for (let i = 0; i < 5; i++) {
                    console.log(`[DEBUG] Verification attempt ${i + 1}...`);
                    const content = await script.projects.getContent({ scriptId });
                    const fileNames = content.data.files ? content.data.files.map(f => f.name) : [];
                    console.log(`[DEBUG] Found files in project: [${fileNames.join(', ')}]`);
                    
                    if (fileNames.includes('appsscript')) {
                        console.log('[SUCCESS] Verification successful! Manifest is present.');
                        manifestExists = true;
                        break;
                    }
                    console.log('[DEBUG] Manifest not yet present, waiting...');
                    await delay(3000); // Wait 3 seconds before retrying
                }

                if (!manifestExists) {
                    throw new Error('Failed to verify manifest file presence after multiple attempts.');
                }

                // STEP D: Now that content is verified, create the deployment.
                console.log('[DEBUG] STEP D: Creating deployment...');
                const deployment = await script.projects.deployments.create({
                    scriptId: scriptId,
                    requestBody: { versionNumber: 1, description: 'Initial verified deployment' }
                });
                const deploymentId = deployment.data.deploymentId;
                console.log(`[SUCCESS] Deployed script. Deployment ID: ${deploymentId}`);

                const deploymentConfig = await script.projects.deployments.get({ scriptId, deploymentId });
                const webAppEntry = deploymentConfig.data.entryPoints?.find(e => e.type === 'WEB_APP');
                if (!webAppEntry || !webAppEntry.webApp) {
                    throw new Error('Web app entry point not found after deployment.');
                }
                const webAppUrl = webAppEntry.webApp.url;
                console.log(`[SUCCESS] Web app URL: ${webAppUrl}`);
                
                await delay(5000); // Allow time for deployment to become active

                // STEP E: Call the web app URL to trigger the setup function.
                const setupUrl = new URL(webAppUrl);
                setupUrl.searchParams.append('secret', API_SECRET_TOKEN);
                setupUrl.searchParams.append('backendApiUrl', API_BASE_URL);
                setupUrl.searchParams.append('userId', userId);
                setupUrl.searchParams.append('connectionId', connectionId.toString());

                console.log(`[DEBUG] STEP E: Calling script setup URL: ${setupUrl.href}`);
                const setupResponse = await fetch(setupUrl.href, { method: 'GET' });
                const setupResult = await setupResponse.json();

                if (!setupResponse.ok || !setupResult.success) {
                    throw new Error(`Failed to set up Apps Script trigger via web app. Reason: ${setupResult.message || 'Unknown error'}`);
                }

                console.log('[SUCCESS] Apps Script self-setup completed successfully via web app call.');
                console.log(`--- Background processing completed successfully for user: ${userId} ---`);
                console.timeEnd(`background_process_duration_${userId}`);

            } catch (backgroundErr) {
                console.error(`--- FATAL ERROR IN BACKGROUND PROCESS for user ${userId} ---`);
                // Enhanced error logging
                console.error("Error Message:", backgroundErr.message);
                if(backgroundErr.code) console.error("Error Code:", backgroundErr.code);
                if(backgroundErr.response?.data) {
                    console.error("Google API Error Details:", JSON.stringify(backgroundErr.response.data, null, 2));
                }
                console.error("Full Error Stack:", backgroundErr.stack);
            }
        });

    } catch (err) {
        console.error("--- FATAL OAUTH CALLBACK ERROR ---");
        console.error("Error Message:", err.message);
        if(err.response?.data) {
            console.error("OAuth Error Details:", JSON.stringify(err.response.data, null, 2));
        }
        console.error("Full Error Stack:", err.stack);
        if (err.response?.data?.error === 'redirect_uri_mismatch') {
            return res.status(500).send("<h1>OAuth Configuration Error</h1><p>The redirect URI is misconfigured. Please contact support.</p>");
        }
        return res.status(500).send("<h1>Authentication Error</h1><p>An error occurred during authentication. Please try again.</p>");
    }
});

module.exports = router;