const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { sendBulkImportMessages } = require('../sqs-service');
const router = express.Router();
const User = require('../models/GoogleUsers');
const GoogleCredential = require('../models/GoogleCredential');
const { scriptContent } = require('../scripts/script_content.js');

const { 
  GOOGLE_CLIENT_ID, 
  GOOGLE_CLIENT_SECRET, 
  GOOGLE_REDIRECT_URI,
  API_SECRET_TOKEN,
  API_BASE_URL,
  FRONTEND_URL
} = process.env;

// Validate required environment variables
const requiredVars = {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET, 
  GOOGLE_REDIRECT_URI,
  API_SECRET_TOKEN,
  API_BASE_URL
};

for (const [key, value] of Object.entries(requiredVars)) {
  if (!value) {
    console.error(`FATAL ERROR: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Helper functions (no changes)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const retryOperation = async (operation, maxRetries = 3, delayMs = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (error.name === 'MongoServerSelectionError' && i < maxRetries - 1) {
        console.warn(`[RETRY_LOG] Database operation failed. Retrying in ${delayMs * (i + 1)}ms...`);
        await delay(delayMs * (i + 1));
      } else {
        throw error;
      }
    }
  }
};

const retryGoogleAPICall = async (apiCall, maxRetries = 5, baseDelayMs = 2000) => {
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

// Apps Script creation function (no changes)
const createAppsScript = async (oauth2Client, spreadsheetId, userId, connectionId) => {
  console.log('[APPS_SCRIPT] Starting creation process...');
  
  const script = google.script({ version: 'v1', auth: oauth2Client });
  let scriptId = null;

  try {
    // Step 1: Create the script project
    console.log('[APPS_SCRIPT] Step 1: Creating script project...');
    const createResponse = await retryGoogleAPICall(() =>
      script.projects.create({
        requestBody: {
          title: `Sheet Sync - ${new Date().toISOString().slice(0, 10)}`,
          parentId: spreadsheetId
        }
      })
    );
    
    scriptId = createResponse.data.scriptId;
    console.log(`[APPS_SCRIPT] Created script with ID: ${scriptId}`);
    
    // Step 2: Wait for project to be ready
    console.log('[APPS_SCRIPT] Step 2: Waiting for script to be ready...');
    await delay(10000); // Initial wait
    
    // Verify script is accessible
    for (let i = 0; i < 10; i++) {
      try {
        await retryGoogleAPICall(() => script.projects.get({ scriptId }));
        console.log(`[APPS_SCRIPT] Script ready after ${i + 1} attempts`);
        break;
      } catch (error) {
        if (i === 9) throw new Error('Script not ready after 10 attempts');
        console.log(`[APPS_SCRIPT] Script not ready, waiting... (${i + 1}/10)`);
        await delay(5000 * (i + 1));
      }
    }
    
    // Step 3: Update with code content
    console.log('[APPS_SCRIPT] Step 3: Adding code content...');
    
    const manifestContent = {
      "timeZone": "Asia/Kolkata",
      "exceptionLogging": "STACKDRIVER", 
      "runtimeVersion": "V8",
      "oauthScopes": [
        "https://www.googleapis.com/auth/spreadsheets.currentonly",
        "https://www.googleapis.com/auth/script.external_request",
         "https://www.googleapis.com/auth/script.scriptapp"
      ],
      "webapp": {
        "access": "ANYONE_ANONYMOUS",
        "executeAs": "USER_DEPLOYING"
      }
    };
    
    await retryGoogleAPICall(() =>
      script.projects.updateContent({
        scriptId,
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
              source: JSON.stringify(manifestContent, null, 2)
            }
          ]
        }
      })
    );
    
    console.log('[APPS_SCRIPT] Code content updated successfully');
    
    // Step 4: Wait for content to be processed
    console.log('[APPS_SCRIPT] Step 4: Waiting for content processing...');
    await delay(15000);
    
    // Verify content is there
    for (let i = 0; i < 8; i++) {
      try {
        const content = await retryGoogleAPICall(() => 
          script.projects.getContent({ scriptId })
        );
        const files = content.data.files || [];
        
        if (files.some(f => f.name === 'Code') && files.some(f => f.name === 'appsscript')) {
          console.log('[APPS_SCRIPT] Content verified successfully');
          break;
        }
        
        if (i === 7) throw new Error('Content not ready after verification attempts');
        console.log(`[APPS_SCRIPT] Content not ready, waiting... (${i + 1}/8)`);
        await delay(5000 * (i + 1));
      } catch (error) {
        if (i === 7) throw error;
        await delay(5000 * (i + 1));
      }
    }
    
    // Step 5: Create version
    console.log('[APPS_SCRIPT] Step 5: Creating version...');
    const versionResponse = await retryGoogleAPICall(() =>
      script.projects.versions.create({
        scriptId,
        requestBody: {
          description: 'Initial deployment version'
        }
      })
    );
    
    const versionNumber = versionResponse.data.versionNumber;
    console.log(`[APPS_SCRIPT] Created version: ${versionNumber}`);
    
    // Step 6: Create deployment
    console.log('[APPS_SCRIPT] Step 6: Creating deployment...');
    const deploymentResponse = await retryGoogleAPICall(() =>
      script.projects.deployments.create({
        scriptId,
        requestBody: {
          versionNumber: versionNumber,
          manifestFileName: 'appsscript',
          description: 'Web app deployment'
        }
      })
    );
    
    const deploymentId = deploymentResponse.data.deploymentId;
    console.log(`[APPS_SCRIPT] Created deployment: ${deploymentId}`);
    
    // Step 7: Get web app URL and wait for it to be ready
    console.log('[APPS_SCRIPT] Step 7: Getting web app URL...');
    await delay(30000); // Wait for deployment to propagate
    
    const deploymentConfig = await retryGoogleAPICall(() =>
      script.projects.deployments.get({ scriptId, deploymentId })
    );
    
    const webAppEntry = deploymentConfig.data.entryPoints?.find(e => e.entryPointType === 'WEB_APP');
    if (!webAppEntry?.webApp?.url) {
      throw new Error('Web app URL not found in deployment');
    }
    
    const webAppUrl = webAppEntry.webApp.url;
    console.log(`[APPS_SCRIPT] Web app URL: ${webAppUrl}`);
    
    // Step 8: Initialize the script with configuration
console.log('[APPS_SCRIPT] Step 8: Initializing script with auto-activation...');

let initSuccess = false;
const maxInitAttempts = 15;

for (let i = 0; i < maxInitAttempts; i++) {
  try {
    // Progressive wait time
    if (i > 0) {
      const waitTime = Math.min(30000 + (i * 15000), 180000);
      console.log(`[APPS_SCRIPT] Waiting ${waitTime/1000}s before attempt ${i + 1}...`);
      await delay(waitTime);
    }
    
    const initResponse = await axios.post(
      webAppUrl,
      {
        secret: API_SECRET_TOKEN,
        backendApiUrl: API_BASE_URL,
        userId: userId,
        connectionId: connectionId.toString(),
        autoActivate: true  // 🔥 NEW: Request auto-activation
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`[APPS_SCRIPT] Init response:`, initResponse.data);
    
    if (initResponse.data && initResponse.data.success) {
      console.log('[APPS_SCRIPT] Initialization successful!');
      
      // Check what type of activation was set up
      if (initResponse.data.delayedActivation) {
        console.log(`🕐 [APPS_SCRIPT] Delayed auto-activation scheduled for ${initResponse.data.activationDelay}`);
        console.log('📋 [APPS_SCRIPT] User will see auto-activation when they open the sheet, or can activate manually');
      } else if (initResponse.data.autoActivated) {
        console.log('🚀 [APPS_SCRIPT] Immediate auto-activation successful! User setup is complete.');
      } else {
        console.log('⚠️ [APPS_SCRIPT] Auto-activation not attempted or failed. User will need to activate manually.');
      }
      
      initSuccess = true;
      break;
    } else {
      throw new Error(`Init failed: ${initResponse.data?.message || 'Unknown error'}`);
    }
    
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    console.log(`[APPS_SCRIPT] Init attempt ${i + 1}/${maxInitAttempts} failed: ${errorMsg}`);
    
    if (i === maxInitAttempts - 1) {
      throw new Error(`Failed to initialize after ${maxInitAttempts} attempts: ${errorMsg}`);
    }
  }
}
    
    if (!initSuccess) {
      throw new Error('Failed to initialize script after all attempts');
    }
    
    console.log('[APPS_SCRIPT] Script created and initialized successfully!');
    
    return {
      scriptId,
      deploymentId,
      webAppUrl,
      versionNumber
    };
    
  } catch (error) {
    console.error(`[APPS_SCRIPT] Creation failed:`, error.message);
    if (scriptId) {
      console.log(`[APPS_SCRIPT] Manual debug URL: https://script.google.com/d/${scriptId}/edit`);
    }
    throw error;
  }
};

// Routes
router.get('/google', (req, res) => {
  const { state } = req.query;
  
  if (!state || state === "{}") {
    return res.status(400).send("State parameter is missing or empty");
  }
  
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      // Basic permissions for your backend
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/spreadsheets',
      
      // Permissions for your backend to create and manage the script
      'https://www.googleapis.com/auth/script.projects',
      'https://www.googleapis.com/auth/script.deployments',
      'https://www.googleapis.com/auth/script.webapp.deploy',
      'https://www.googleapis.com/auth/drive.file',

    ],
    prompt: 'consent',
    state
  });
  
  res.redirect(authUrl);
});

// The rest of your file remains exactly the same.
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code || !state) {
    return res.status(400).send("Missing authorization code or state");
  }
  
  let decodedState;
  try {
    decodedState = JSON.parse(decodeURIComponent(state));
  } catch (err) {
    return res.status(400).send("Invalid state parameter");
  }
  
  const { sheetId, sheetRange, userId } = decodedState;
  
  if (!sheetId || !sheetRange || !userId) {
    return res.status(400).send("Missing required parameters in state");
  }
  
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET, 
    GOOGLE_REDIRECT_URI
  );
  
  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('[AUTH] OAuth tokens obtained successfully');
    
    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const userEmail = userInfo.data.email;
    console.log(`[AUTH] User email: ${userEmail}`);
    
    // Save credentials to database
    const newConnection = await retryOperation(() =>
      GoogleCredential.create({
        userId,
        spreadsheetId: sheetId,
        sheetRange,
        googleTokens: tokens,
        userEmail,
        rows: [],
        appsScriptId: null // Will be updated after script creation
      })
    );
    
    const connectionId = newConnection._id.toString();
    console.log(`[AUTH] Created connection: ${connectionId}`);
    
    // Update user record
    await retryOperation(() =>
      User.findByIdAndUpdate(userId, { 
        $set: { google_credential_id: connectionId } 
      })
    );
    
    // Redirect user back to frontend
    const redirectUrl = `${FRONTEND_URL || 'https://demo.portfolio-vue.com/'}/dashboard/settings/profile-management`;
    res.redirect(redirectUrl);

    // Start background processing
    setImmediate(async () => {
      try {
        console.log(`[BACKGROUND] Starting processing for user: ${userId}`);
        console.time(`background_process_${userId}`);
        
        // Step 1: Process initial spreadsheet data
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        const range = `${sheetRange}!A1:AZ1000`;
        
        const sheetResponse = await retryGoogleAPICall(() =>
          sheets.spreadsheets.values.get({ 
            spreadsheetId: sheetId, 
            range 
          })
        );
        
        const rows = sheetResponse.data.values;
        
        if (rows && rows.length > 1) {
          console.log(`[BACKGROUND] Found ${rows.length - 1} data rows to import`);
          
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
              connectionId: connectionId,
              userId: userId,
              spreadsheet_id: sheetId,
              sheet_range: range,
              row_index: index + 2,
              project_identifier: input_data["Project"] || "Unnamed Project",
              sync_timestamp: new Date().toISOString(),
              input_data
            };
          });
          
          await sendBulkImportMessages(formattedData);
          console.log(`[BACKGROUND] Sent ${formattedData.length} messages to SQS`);
          
        } else {
          console.log('[BACKGROUND] No data rows found in spreadsheet');
        }
        
        // Step 2: Create Apps Script for real-time updates
        console.log('[BACKGROUND] Creating Apps Script...');
        
        const scriptResult = await createAppsScript(
          oauth2Client, 
          sheetId, 
          userId, 
          connectionId
        );
        
        // Update the connection record with script info
        await retryOperation(() =>
          GoogleCredential.findByIdAndUpdate(connectionId, {
            $set: { 
              appsScriptId: scriptResult.scriptId,
              webAppUrl: scriptResult.webAppUrl,
              deploymentId: scriptResult.deploymentId
            }
          })
        );
        
        console.log(`[BACKGROUND] Apps Script created successfully: ${scriptResult.scriptId}`);
        console.log(`[BACKGROUND] Background processing completed for user: ${userId}`);
        console.timeEnd(`background_process_${userId}`);
        
      } catch (backgroundError) {
        console.error(`[BACKGROUND] Processing failed for user ${userId}:`, {
          message: backgroundError.message,
          stack: backgroundError.stack,
          code: backgroundError.code
        });
      }
    });
    
  } catch (authError) {
    console.error('[AUTH] Callback error:', {
      message: authError.message,
      code: authError.code,
      response: authError.response?.data
    });
    
    return res.status(500).send(
      "<h1>Authentication Error</h1>" +
      "<p>There was an error during authentication. Please try again.</p>" +
      `<p>Error: ${authError.message}</p>`
    );
  }
});

module.exports = router;
