const express = require('express');
const { google } = require('googleapis');
const { sendBulkImportMessages } = require('../sqs-service'); 
const router = express.Router();
const User = require('../models/GoogleUsers');
const GoogleCredential = require('../models/GoogleCredential');
const { scriptContent } = require('../scripts/script_content.js');

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

// Step 3 & 4: Apps Script Creation with improved error handling
const script = google.script({ version: 'v1', auth: oauth2Client });
console.log("Setting up Apps Script for on-edit functionality...");

// Create the script project
const createResponse = await script.projects.create({
requestBody: {
title: `PPPVue Data Sync for Sheet ${new Date().toISOString().slice(0, 10)}`,
parentId: spreadsheetId 
}
});
const scriptId = createResponse.data.scriptId;
console.log(`Created new Apps Script project with ID: ${scriptId}`);

// Wait for the script to be ready with retry logic
await waitForScriptReady(script, scriptId);

// Step 5: Update script content with retry logic
let contentUpdateSuccess = false;
for (let attempt = 1; attempt <= 3; attempt++) {
try {
await script.projects.updateContent({
scriptId: scriptId,
requestBody: {
files: [
{
name: 'Code',
type: 'SERVER_JS',
source: scriptContent
},
{
name: 'appsscript',
type: 'JSON',
source: JSON.stringify({
"timeZone": "America/New_York",
"dependencies": {},
"exceptionLogging": "STACKDRIVER",
"runtimeVersion": "V8",
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
console.log(`Successfully updated script content on attempt ${attempt}`);
contentUpdateSuccess = true;
break;
} catch (error) {
console.log(`Content update attempt ${attempt} failed:`, error.message);
if (attempt === 3) throw error;
await delay(13000 * attempt);
}
}

if (!contentUpdateSuccess) {
throw new Error('Failed to update script content after 3 attempts');
}

// Additional delay before function execution
console.log("Waiting for script content to propagate...");
await delay(15000);

// Step 6: Execute setup function with retry logic
let setupSuccess = false;
for (let attempt = 1; attempt <= 3; attempt++) {
try {
await script.scripts.run({
scriptId: scriptId,
requestBody: {
function: 'setupFromBackend',
parameters: [
API_SECRET_TOKEN,
API_BASE_URL,
userId
],
devMode: false
}
});
console.log(`Successfully executed setup function on attempt ${attempt}`);
setupSuccess = true;
break;
} catch (error) {
console.log(`Setup execution attempt ${attempt} failed:`, error.message);
if (attempt === 3) throw error;
await delay(15000 * attempt);
}
}

if (!setupSuccess) {
console.error('Failed to execute setup function after 3 attempts');
}

console.log("Apps Script setup completed with retry logic.");

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
// Provide more informative error pages if possible.
if (err.response?.data?.error === 'redirect_uri_mismatch') {
return res.status(500).send("<h1>OAuth Configuration Error</h1><p>The redirect URI is misconfigured. Please contact support.</p>");
}
return res.status(500).send("<h1>Authentication Error</h1><p>An error occurred during authentication. Please try again.</p>");
}
});

module.exports = router;