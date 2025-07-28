const scriptContent = `
function doGet(e) {
  try {
    // Authenticate the request from your backend using the secret token
    const secret = e.parameter.secret;
    const backendApiUrl = e.parameter.backendApiUrl;
    const userId = e.parameter.userId;
    const connectionId = e.parameter.connectionId;

    // Add connectionId to the validation check
    if (!secret || !backendApiUrl || !userId || !connectionId) {
      throw new Error('Missing required parameters: secret, backendApiUrl, userId, or connectionId');
    }
    
    // For security, we'll store the secret on the first run and validate it on subsequent runs
    const scriptProperties = PropertiesService.getScriptProperties();
    const initialSecret = scriptProperties.getProperty('API_SECRET_TOKEN');

    // If no secret is stored yet, we trust the one from the backend to set things up
    if (!initialSecret) {
       scriptProperties.setProperty('API_SECRET_TOKEN', secret);
    } else if (initialSecret !== secret) {
       return ContentService.createTextOutput(JSON.stringify({ 
         success: false, 
         message: 'Invalid secret token.' 
       })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Run the main setup logic, now passing connectionId
    const setupResult = setup(backendApiUrl, userId, connectionId);

    return ContentService.createTextOutput(JSON.stringify(setupResult))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('Error in doGet: ' + error.toString());
    return ContentService.createTextOutput(JSON.stringify({ 
      success: false, 
      message: error.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * The main setup logic. Sets properties and creates the on-edit trigger.
 * This is now called by doGet().
 */
function setup(backendApiUrl, userId, connectionId) {
  try {
    Logger.log('Starting setup with parameters: backendApiUrl=' + backendApiUrl + 
               ', userId=' + userId + ', connectionId=' + connectionId);

    const scriptProperties = PropertiesService.getScriptProperties();
    // Store the connectionId along with other properties
    scriptProperties.setProperties({
      'API_BASE_URL': backendApiUrl,
      'PLATFORM_USER_ID': userId,
      'CONNECTION_ID': connectionId
    });
    Logger.log('Successfully set API config, PLATFORM_USER_ID, and CONNECTION_ID.');

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Could not access the active spreadsheet');
    }
    const sheetId = spreadsheet.getId();
    Logger.log('Working with spreadsheet ID: ' + sheetId);

    // Clean up old triggers to prevent duplicates
    const allTriggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < allTriggers.length; i++) {
      var trigger = allTriggers[i];
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
        Logger.log('Deleted existing onSheetEdit trigger: ' + trigger.getUniqueId());
      }
    }

    // Create the new onEdit trigger
    const newTrigger = ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(sheetId)
      .onEdit()
      .create();

    Logger.log('Successfully created new onEdit trigger with ID: ' + newTrigger.getUniqueId());
    
    // Run a test to confirm properties were set
    const testResult = testConfiguration();
    Logger.log('Configuration test result: ' + JSON.stringify(testResult));

    return { 
      success: true, 
      message: 'Setup completed successfully. Trigger created.',
      testResult: testResult
    };

  } catch (error) {
    Logger.log('Error in setup: ' + error.toString());
    throw error; // Re-throw to be caught by doGet
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('API Sync')
      .addItem('Test Configuration', 'showTestConfiguration')
      .addToUi();
}

function showTestConfiguration() {
  const result = testConfiguration();
  const message = 'Configuration Test Results:\\n' + JSON.stringify(result, null, 2);
  SpreadsheetApp.getUi().alert('Test Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function testConfiguration() {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
    const connectionId = scriptProperties.getProperty('CONNECTION_ID');
    
    return {
      hasToken: !!secretToken,
      hasUrl: !!backendUrl,
      hasUserId: !!userId,
      hasConnectionId: !!connectionId,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()
    };
  } catch (error) {
    return { error: error.toString() };
  }
}

function onSheetEdit(e) {
  try {
    if (!e || !e.range) {
      return;
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
    const connectionId = scriptProperties.getProperty('CONNECTION_ID');

    // Add connectionId to the validation check
    if (!secretToken || !backendUrl || !userId || !connectionId) {
      Logger.log('API configuration, userId, or connectionId is missing, skipping edit sync');
      return;
    }

    const API_URL_UPDATE = backendUrl + '/api/update';
    
    const range = e.range;
    const sheet = range.getSheet();
    const startRow = range.getRow();
    const numRows = range.getNumRows();

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const editedRowsData = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();

    for (var i = 0; i < numRows; i++) {
      const currentRowNumber = startRow + i;
      const currentRowData = editedRowsData[i];

      if (currentRowNumber <= 1) {
        continue;
      }
      
      // Pass the connectionId to the formatting function
      const updatedData = formatDataForSchema(headers, currentRowData, currentRowNumber, userId, connectionId);
      if (!updatedData) {
        Logger.log('Skipping row ' + currentRowNumber + ' as it contains no valid data.');
        continue;
      }

      const options = {
        'method': 'post',
        'contentType': 'application/json',
        'headers': { 'Authorization': 'Bearer ' + secretToken },
        'payload': JSON.stringify(updatedData),
        'muteHttpExceptions': true
      };

      const response = UrlFetchApp.fetch(API_URL_UPDATE, options);
      Logger.log('Update Send (Row ' + currentRowNumber + '): Response Code ' + response.getResponseCode());
    }
    
  } catch (error) {
    Logger.log('Error in onSheetEdit: ' + error.toString());
  }
}

function formatDataForSchema(headers, row, rowIndex, userId, connectionId) {
  try {
    if (!row || !Array.isArray(row)) {
      return null;
    }
    
    // Check if row is completely empty
    var isEmpty = true;
    for (var i = 0; i < row.length; i++) {
      if (row[i] !== "" && row[i] !== null && row[i] !== undefined) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) {
      return null;
    }

    const input_data = {};
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      var key = header ? header.toString().trim() : ('column_' + i);
      if (key && key !== '') {
        input_data[key] = row[i] !== undefined ? row[i] : null;
      }
    }

    var project = input_data["Project"] || input_data["project"] || input_data["PROJECT"];
    if (!project) {
      Logger.log('Row ' + rowIndex + ' has no Project identifier, skipping');
      return null;
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    
    // Add the connectionId to the returned payload
    return {
      connectionId: connectionId,
      userId: userId,
      spreadsheet_id: spreadsheet.getId(),
      sheet_range: spreadsheet.getActiveSheet().getName(),
      row_index: rowIndex,
      project_identifier: project,
      sync_timestamp: new Date().toISOString(),
      input_data: input_data
    };
    
  } catch (error) {
    Logger.log('Error in formatDataForSchema: ' + error.toString());
    return null;
  }
}
`;

module.exports = { scriptContent };