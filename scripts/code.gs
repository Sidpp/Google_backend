/**
 * Stores the secret token and the base URL for your backend API.
 * This function is called by your Node.js server after successful user authentication.
 * It is the core of the automated setup.
 * @param {string} secret The secret token for API authorization.
 * @param {string} backendApiUrl The public base URL of your backend (e.g., https://your-app.com).
 */
function setSecretTokenFromBackend(secret, backendApiUrl) {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('API_SECRET_TOKEN', secret);
  scriptProperties.setProperty('BACKEND_API_URL', backendApiUrl);
  Logger.log('Successfully set API secret and backend URL.');
}

/**
 * Creates the installable onEdit trigger for the spreadsheet.
 * This is also called by the backend to automate the setup.
 * It includes logic to prevent creating duplicate triggers.
 */
function createTrigger() {
  const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  
  // Delete any existing triggers to avoid duplicates from multiple authentications.
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  
  // Create a new trigger that calls 'onSheetEdit' whenever an edit occurs.
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(sheetId)
    .onEdit()
    .create();
  Logger.log('Successfully created onEdit trigger.');
}


// --- MANUAL & DEBUGGING FUNCTIONS ---
// These functions create a menu in the Google Sheet UI. They are not required for the main
// automated flow but are extremely useful for testing or for manual re-syncing.

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('🚀 API Sync')
      .addItem('📤 Send All Data to API', 'sendAllData')
      .addSeparator()
      .addItem('🔑 (Manual) Set API Config', 'setupManualConfig')
      .addToUi();
}

/**
 * Manually prompts the user for the API config. Only needed for debugging.
 */
function setupManualConfig() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Manual API Config',
    'Enter API URL and Token, separated by a comma (e.g., https://my-app.com,my-secret-token)',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.OK) {
    const [url, token] = response.getResponseText().split(',').map(s => s.trim());
    if (url && token) {
      setSecretTokenFromBackend(token, url);
      ui.alert('✅ Success', 'Manual API config has been saved.', ui.ButtonSet.OK);
    } else {
      ui.alert('Error', 'Invalid format. Please provide both URL and Token.', ui.ButtonSet.OK);
    }
  }
}


// --- CORE API COMMUNICATION FUNCTIONS ---

/**
 * Sends all data from the active sheet to the backend's /api/bulk-import endpoint.
 * It automatically handles batching to stay within Google's payload size limits.
 */
function sendAllData() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('BACKEND_API_URL');
  
  if (!secretToken || !backendUrl) {
    SpreadsheetApp.getUi().alert('API configuration is missing. Please re-authenticate from the main application to set it up.');
    return;
  }
  
  // Dynamically construct the full API endpoint URL.
  const API_URL_BULK = backendUrl + '/api/bulk-import';
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const allSheetData = sheet.getDataRange().getValues();
  const headers = allSheetData.shift(); // Get headers and remove them from the data

  const jsonData = allSheetData
    .map((row, index) => formatDataForSchema(headers, row, index + 2)) // index + 2 for correct row number
    .filter(item => item !== null);

  if (jsonData.length === 0) {
    SpreadsheetApp.getUi().alert('ℹ️ No data to send.');
    return;
  }

  // Send data in batches. This acts as pagination for your SQS queue.
  const batchSize = 200; 
  for (let i = 0; i < jsonData.length; i += batchSize) {
    const batch = jsonData.slice(i, i + batchSize);
    const options = {
      'method' : 'post',
      'contentType': 'application/json',
      'headers': { 'Authorization': 'Bearer ' + secretToken },
      'payload' : JSON.stringify({ data: batch }), // Backend expects { "data": [...] }
      'muteHttpExceptions': true
    };
    
    const response = UrlFetchApp.fetch(API_URL_BULK, options);
    Logger.log(`Bulk Send (Batch ${Math.floor(i / batchSize) + 1}): Response Code ${response.getResponseCode()}`);
  }

  SpreadsheetApp.getUi().alert(` Sent ${jsonData.length} rows to the API.`);
}

/**
 * An installable trigger that runs automatically when a user edits the spreadsheet.
 * Sends the data of the edited row to the /api/update endpoint.
 * @param {Object} e The event object from the onEdit trigger.
 */
function onSheetEdit(e) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('BACKEND_API_URL');

  // Exit silently if config is not set. This prevents errors on sheets not yet configured.
  if (!secretToken || !backendUrl) return; 

  // Dynamically construct the full API endpoint URL.
  const API_URL_UPDATE = backendUrl + '/api/update';
  
  const range = e.range;
  const sheet = range.getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const editedRowData = sheet.getRange(range.getRow(), 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const updatedData = formatDataForSchema(headers, editedRowData, range.getRow());
  if (!updatedData) return; // Exit if the row was empty.

  const options = {
    'method' : 'post',
    'contentType': 'application/json',
    'headers': { 'Authorization': 'Bearer ' + secretToken },
    'payload' : JSON.stringify(updatedData), // Backend expects the object directly
    'muteHttpExceptions': true
  };

  const response = UrlFetchApp.fetch(API_URL_UPDATE, options);
  Logger.log(`Update Send (Row ${range.getRow()}): Response Code ${response.getResponseCode()}`);
}


// --- UTILITY FUNCTION ---

/**
 * Converts a row array into a structured JavaScript object using headers as keys.
 * @param {string[]} headers The array of header names from the first row.
 * @param {Array} row The array of cell values for a single row.
 * @param {number} rowIndex The actual row number from the sheet.
 * @returns {Object|null} A formatted object, or null if the row is empty.
 */
function formatDataForSchema(headers, row, rowIndex) {
  if (!row || row.every(cell => cell === "")) {
    return null;
  }

  const obj = {
    rowIndex: rowIndex 
  };

  headers.forEach((header, i) => {
    const key = header.toString().trim();
    if (key) {
      obj[key] = row[i];
    }
  });

  return obj;
}
