function setupFromBackend(secret, backendApiUrl) {
  // Set the properties
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('API_SECRET_TOKEN', secret);
  scriptProperties.setProperty('API_BASE_URL', backendApiUrl);
  Logger.log('Successfully set API secret and backend URL.');
  
  // Create the trigger
  const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(sheetId)
    .onEdit()
    .create();
  Logger.log('Successfully created onEdit trigger.');
}


// --- The rest of your Apps Script file remains the same ---
// (onOpen, setupManualConfig, sendAllData, onSheetEdit, formatDataForSchema)

function setSecretTokenFromBackend(secret, backendApiUrl) {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('API_SECRET_TOKEN', secret);
  scriptProperties.setProperty('API_BASE_URL', backendApiUrl);
  Logger.log('Successfully set API secret and backend URL.');
}

function createTrigger() {
  const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(sheetId)
    .onEdit()
    .create();
  Logger.log('Successfully created onEdit trigger.');
}

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('🚀 API Sync')
      .addItem('📤 Send All Data to API', 'sendAllData')
      .addSeparator()
      .addItem('🔑 (Manual) Set API Config', 'setupManualConfig')
      .addToUi();
}

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

function sendAllData() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('API_BASE_URL'); // Corrected property name
  
  if (!secretToken || !backendUrl) {
    SpreadsheetApp.getUi().alert('API configuration is missing. Please re-authenticate from the main application to set it up.');
    return;
  }
  
  const API_URL_BULK = backendUrl + '/api/bulk-import';
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const allSheetData = sheet.getDataRange().getValues();
  const headers = allSheetData.shift(); 

  const jsonData = allSheetData
    .map((row, index) => formatDataForSchema(headers, row, index + 2))
    .filter(item => item !== null);

  if (jsonData.length === 0) {
    SpreadsheetApp.getUi().alert('ℹ️ No data to send.');
    return;
  }

  const batchSize = 200;  
  for (let i = 0; i < jsonData.length; i += batchSize) {
    const batch = jsonData.slice(i, i + batchSize);
    const options = {
      'method' : 'post',
      'contentType': 'application/json',
      'headers': { 'Authorization': 'Bearer ' + secretToken },
      'payload' : JSON.stringify({ data: batch }),
      'muteHttpExceptions': true
    };
    
    const response = UrlFetchApp.fetch(API_URL_BULK, options);
    Logger.log(`Bulk Send (Batch ${Math.floor(i / batchSize) + 1}): Response Code ${response.getResponseCode()}`);
  }

  SpreadsheetApp.getUi().alert(` Sent ${jsonData.length} rows to the API.`);
}

function onSheetEdit(e) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('API_BASE_URL'); // Corrected property name

  if (!secretToken || !backendUrl) return;  

  const API_URL_UPDATE = backendUrl + '/api/update';
  
  const range = e.range;
  const sheet = range.getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const editedRowData = sheet.getRange(range.getRow(), 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const updatedData = formatDataForSchema(headers, editedRowData, range.getRow());
  if (!updatedData) return;

  const options = {
    'method' : 'post',
    'contentType': 'application/json',
    'headers': { 'Authorization': 'Bearer ' + secretToken },
    'payload' : JSON.stringify(updatedData),
    'muteHttpExceptions': true
  };

  const response = UrlFetchApp.fetch(API_URL_UPDATE, options);
  Logger.log(`Update Send (Row ${range.getRow()}): Response Code ${response.getResponseCode()}`);
}

function formatDataForSchema(headers, row, rowIndex) {
  if (!row || row.every(cell => cell === "")) {
    return null;
  }

  const input_data = {};
  headers.forEach((header, i) => {
    const key = header.toString().trim();
    if (key) {
      input_data[key] = row[i];
    }
  });

  const project = input_data["Project"];
  if (!project) return null;

  const spreadsheet_id = SpreadsheetApp.getActiveSpreadsheet().getId();
  const sheet_name = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();
  const range = `${sheet_name}!A1:AZ1000`;

  return {
    spreadsheet_id,
    sheet_range: range,
    row_index: rowIndex,
    project_identifier: project,
    sync_timestamp: new Date().toISOString(),
    input_data
  };
}