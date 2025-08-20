const express = require('express');
const { google } = require('googleapis');
const axios = require('axios'); // Import axios
const { sendBulkImportMessages } = require('../sqs-service');
const router = express.Router();
const User = require('../models/GoogleUsers');
const GoogleCredential = require('../models/GoogleCredential');
const { scriptContent } = require('../scripts/script_content.js');



const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, API_SECRET_TOKEN, API_BASE_URL } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !API_SECRET_TOKEN || !API_BASE_URL) {
    console.error("FATAL ERROR: Missing required Google OAuth or API Secret environment variables.");
    process.exit(1);
}

// Helper functions (retryOperation, delay, retryGoogleAPICall, waitForScriptReady) remain the same...
const retryOperation = async (operation, maxRetries = 3, delayMs = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (error.name === 'MongoServerSelectionError' && i < maxRetries - 1) {
                console.warn(`[RETRY_LOG] Database operation failed. Retrying in ${delayMs * (i + 1) / 1000}s... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
            } else {
                console.error(`[FATAL_DB_ERROR] Database operation failed after ${maxRetries} retries.`);
                throw error;
            }
        }
    }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const retryGoogleAPICall = async (apiCall, maxRetries = 3, baseDelayMs = 2000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await apiCall();
        } catch (error) {
            const isRetryableError =
                error.code >= 500 ||
                error.code === 429 ||
                error.message?.includes('timeout') ||
                error.message?.includes('INTERNAL_ERROR') ||
                error.message?.includes('SERVICE_UNAVAILABLE');

            if (isRetryableError && i < maxRetries - 1) {
                const delayMs = baseDelayMs * Math.pow(2, i);
                console.log(`[RETRY_LOG] Google API call failed (${error.message}). Retrying in ${delayMs}ms... (Attempt ${i + 1}/${maxRetries})`);
                await delay(delayMs);
            } else {
                throw error;
            }
        }
    }
};

const waitForScriptReady = async (script, scriptId, maxRetries = 8) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await retryGoogleAPICall(() => script.projects.get({ scriptId }));
            console.log(`[DEBUG_LOG] Script project ${scriptId} is ready after ${i + 1} attempts`);
            return true;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw new Error(`Script project ${scriptId} not ready after ${maxRetries} attempts. Last error: ${error.message}`);
            }
            console.log(`[DEBUG_LOG] Script not ready, attempt ${i + 1}/${maxRetries}. Waiting...`);
            await delay(3000 * (i + 1));
        }
    }
};


// Pass the oauth2Client into this function
const createAppsScriptProject = async (oauth2Client, script, spreadsheetId, userId, connectionId) => {
    console.log("[DEBUG_LOG] --- Starting Apps Script Setup ---");

    let scriptId; // Define scriptId here to be accessible in the catch block

    try {
        // STEP 1: Create empty project
        console.log('[DEBUG_LOG] STEP 1: Creating empty Apps Script project...');
        const createRequest = {
            title: `Vue Data Sync ${new Date().toISOString()}`,
            parentId: spreadsheetId
        };

        const createResponse = await retryGoogleAPICall(() =>
            script.projects.create({ requestBody: createRequest })
        );

        scriptId = createResponse.data.scriptId; // Assign scriptId
        console.log(`[SUCCESS_LOG] Created empty Apps Script project. ID: ${scriptId}`);

        // STEP 2: Wait for project to be ready
        console.log('[DEBUG_LOG] STEP 2: Waiting for project to be ready...');
        await waitForScriptReady(script, scriptId);

        // STEP 3: Update project with code and manifest
        console.log('[DEBUG_LOG] STEP 3: Updating project with code and manifest...');

        const manifestObject = {
            "timeZone": "Asia/Kolkata",
            "exceptionLogging": "STACKDRIVER",
            "runtimeVersion": "V8",
            "oauthScopes": [
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/script.external_request",
                "https://www.googleapis.com/auth/script.scriptapp"
            ],
            "webapp": {
                "access": "ANYONE_ANONYMOUS",
                "executeAs": "USER_DEPLOYING"
            }
        };

        const updateRequest = {
            scriptId: scriptId,
            requestBody: {
                files: [
                    { name: 'Code', type: 'SERVER_JS', source: scriptContent },
                    { name: 'appsscript', type: 'JSON', source: JSON.stringify(manifestObject, null, 2) }
                ]
            }
        };

        await retryGoogleAPICall(() =>
            script.projects.updateContent(updateRequest)
        );
        console.log('[SUCCESS_LOG] Successfully updated project with code and manifest');

        // STEPS 4 & 5 (Wait and Verify) remain the same...
        console.log('[DEBUG_LOG] STEP 4: Waiting for content to be processed...');
        await delay(15000);
        console.log('[DEBUG_LOG] STEP 5: Verifying project content...');
        let contentVerified = false;
        for (let i = 0; i < 8; i++) {
            try {
                const content = await retryGoogleAPICall(() => script.projects.getContent({ scriptId }));
                const files = content.data.files || [];
                if (files.some(f => f.name === 'Code') && files.some(f => f.name === 'appsscript')) {
                    console.log('[SUCCESS_LOG] Content verification successful!');
                    contentVerified = true;
                    break;
                }
                console.log(`[DEBUG_LOG] Content not yet ready, waiting... (attempt ${i + 1}/8)`);
                await delay(5000 * (i + 1));
            } catch (error) {
                console.log(`[DEBUG_LOG] Content verification attempt ${i + 1} failed: ${error.message}`);
                if (i === 7) throw error;
                await delay(5000 * (i + 1));
            }
        }
        if (!contentVerified) {
            throw new Error('Failed to verify project content after multiple attempts');
        }

        // STEP 6: Create version
        console.log('[DEBUG_LOG] STEP 6: Creating project version...');
        const versionResponse = await retryGoogleAPICall(() =>
            script.projects.versions.create({
                scriptId: scriptId,
                requestBody: { description: 'Initial version for web app deployment' }
            })
        );
        const versionNumber = versionResponse.data.versionNumber;
        console.log(`[SUCCESS_LOG] Created project version: ${versionNumber}`);

        // STEP 7: Create deployment
        console.log('[DEBUG_LOG] STEP 7: Creating deployment...');
        const deployment = await retryGoogleAPICall(() =>
            script.projects.deployments.create({
                scriptId: scriptId,
                requestBody: {
                    versionNumber: versionNumber,
                    manifestFileName: 'appsscript',
                    description: 'Web app deployment'
                }
            })
        );
        const deploymentId = deployment.data.deploymentId;
        console.log(`[SUCCESS_LOG] Created deployment. ID: ${deploymentId}`);

        // STEP 8: Get web app URL
        console.log('[DEBUG_LOG] STEP 8: Getting web app URL...');
        await delay(30000);

        const deploymentConfig = await retryGoogleAPICall(() =>
            script.projects.deployments.get({ scriptId, deploymentId })
        );
        const webAppEntry = deploymentConfig.data.entryPoints?.find(e => e.entryPointType === 'WEB_APP');
        if (!webAppEntry?.webApp?.url) {
            throw new Error('Web app URL not found in deployment configuration');
        }
        const webAppUrl = webAppEntry.webApp.url;
        console.log(`[SUCCESS_LOG] Web app URL obtained: ${webAppUrl}`);

        // =================================================================
        // STEP 9: CORRECTED - Call setup endpoint with authenticated POST
        // =================================================================
        console.log('[DEBUG_LOG] STEP 9: Calling setup endpoint with authentication...');
        
        // Get the current access token from the authenticated client
        const { token: accessToken } = await oauth2Client.getAccessToken();
        if (!accessToken) {
            throw new Error('Could not retrieve access token for the setup call.');
        }

        let setupSuccess = false;
        for (let i = 0; i < 8; i++) {
            try {
                const setupResponse = await axios.post(
                    webAppUrl,
                    { // Parameters are now in the POST body
                        secret: API_SECRET_TOKEN,
                        backendApiUrl: API_BASE_URL,
                        userId: userId,
                        connectionId: connectionId.toString()
                    },
                    { // The Authorization header authenticates the request
                        headers: {
                            'Authorization': `Bearer ${accessToken}`
                        },
                        timeout: 60000
                    }
                );

                const setupResult = setupResponse.data;
                console.log(`[DEBUG_LOG] Setup response: ${JSON.stringify(setupResult)}`);

                if (setupResult.success) {
                    console.log('[SUCCESS_LOG] Apps Script setup completed successfully');
                    setupSuccess = true;
                    break; // Success, exit the loop
                } else {
                    // This is an error reported by the script itself
                    throw new Error(`Setup failed: ${setupResult.message || 'Unknown error from script'}`);
                }

            } catch (error) {
                const waitTime = Math.min(15000 * Math.pow(2, i), 120000);
                // Axios puts server error details in error.response.data
                const errorMessage = error.response?.data?.message || error.message;
                console.log(`[DEBUG_LOG] Setup attempt ${i + 1}/8 failed: ${errorMessage}`);
                console.log(`[DEBUG_LOG] Waiting ${waitTime / 1000} seconds before retry...`);

                if (i === 7) {
                    throw new Error(`Setup failed after multiple retries: ${errorMessage}`);
                }
                await delay(waitTime);
            }
        }

        if (!setupSuccess) {
            throw new Error('Failed to complete setup after multiple attempts. Check logs for details.');
        }

        return { scriptId, deploymentId, webAppUrl, versionNumber };

    } catch (error) {
        console.error(`[ERROR_LOG] Apps Script setup failed: ${error.message}`);
        if (scriptId) {
            // Log the script URL for manual debugging if we have the ID
            console.log(`[INFO_LOG] Manual verification URL: https://script.google.com/d/${scriptId}/edit`);
        }
        throw error;
    }
};

// Router endpoints remain the same, but the callback logic is updated
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
            'https://www.googleapis.com/auth/script.webapp.deploy',
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
        return res.status(400).send("Spreadsheet ID, Sheet Range, or User ID was missing from the state.");
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
        console.log("[DEBUG_LOG] Successfully retrieved OAuth tokens.");

        const newConnection = await retryOperation(() =>
            GoogleCredential.create({
                userId: userId,
                spreadsheetId: spreadsheetId,
                sheetRange: sheetRange,
                googleTokens: tokens,
                rows: []
            })
        );
        const connectionId = newConnection._id;
        console.log(`[DEBUG_LOG] Created new Google credential with ID: ${connectionId}`);

        await retryOperation(() =>
            User.findByIdAndUpdate(userId, {
                $set: { google_credential_id: connectionId }
            })
        );

        const frontendAppUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendAppUrl}/dashboard/settings/profile`);

        setImmediate(async () => {
            try {
                console.log(`--- [DEBUG_LOG] Starting background processing for user: ${userId} ---`);
                console.time(`background_process_duration_${userId}`);

                // Process spreadsheet data (this part is unchanged)
                const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
                const sheetResponse = await retryGoogleAPICall(() =>
                    sheets.spreadsheets.values.get({ spreadsheetId, range })
                );
                const rows = sheetResponse.data.values;

                if (rows && rows.length > 1) {
                    console.log(`[DEBUG_LOG] Found ${rows.length - 1} data rows in the sheet.`);
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
                    await sendBulkImportMessages(formattedData);
                    console.log(`[DEBUG_LOG] Successfully sent ${formattedData.length} messages to SQS for user ${userId}.`);
                } else {
                    console.log(`[DEBUG_LOG] No data rows found in the sheet for user ${userId}.`);
                }

                // Create Apps Script project
                const script = google.script({ version: 'v1', auth: oauth2Client });
                // Pass the authenticated oauth2Client to the function
                await createAppsScriptProject(oauth2Client, script, spreadsheetId, userId, connectionId);

                console.log(`--- [SUCCESS_LOG] Background processing completed successfully for user: ${userId} ---`);
                console.timeEnd(`background_process_duration_${userId}`);

            } catch (backgroundErr) {
                console.error(`--- [FATAL_ERROR] IN BACKGROUND PROCESS for user ${userId} ---`);
                console.error("Error Message:", backgroundErr.message);
                if (backgroundErr.code) console.error("Error Code:", backgroundErr.code);
                if (backgroundErr.response?.data) {
                    console.error("Google API Error Details:", JSON.stringify(backgroundErr.response.data, null, 2));
                }
                console.error("Full Error Stack:", backgroundErr.stack);
            }
        });

    } catch (err) {
        console.error("--- [FATAL_ERROR] OAUTH CALLBACK ERROR ---");
        console.error("Error Message:", err.message);
        if (err.response?.data) {
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