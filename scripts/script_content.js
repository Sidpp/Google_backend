const scriptContent = `
function doPost(e) {
  const response = { success: false, message: 'An unknown error occurred.' };
  
  try {
    // STEP 1: Validate the OAuth2 Access Token from the Authorization header.
    const authHeader = e.headers['authorization'] || e.headers['Authorization'];
    if (!authHeader) {
      throw new Error('Request is missing the Authorization header.');
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      throw new Error('Malformed Authorization header. Expected "Bearer <token>".');
    }

    // STEP 2: Verify the token with Google's tokeninfo endpoint.
    const tokenInfoUrl = 'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + token;
    const tokenInfoResponse = UrlFetchApp.fetch(tokenInfoUrl, { 'muteHttpExceptions': true });
    const tokenInfo = JSON.parse(tokenInfoResponse.getContentText());

    if (tokenInfo.error) {
      throw new Error('Token is invalid: ' + (tokenInfo.error_description || tokenInfo.error));
    }

    // STEP 3: CRITICAL - Ensure the user making the call is the same user who deployed the script.
    // This prevents unauthorized execution and is the core fix for the 403 error.
    const effectiveUserEmail = Session.getEffectiveUser().getEmail();
    const tokenUserEmail = tokenInfo.email;

    if (!effectiveUserEmail || effectiveUserEmail !== tokenUserEmail) {
      throw new Error('Token validation failed. The calling user (' + tokenUserEmail + ') does not match the script owner (' + effectiveUserEmail + ').');
    }
    
    Logger.log('Token validated successfully for user: ' + effectiveUserEmail);

    // STEP 4: Parse the parameters from the POST body.
    if (!e.postData || !e.postData.contents) {
        throw new Error('Request is missing postData.');
    }
    const payload = JSON.parse(e.postData.contents);
    const { secret, backendApiUrl, userId, connectionId } = payload;

    Logger.log('doPost called with parameters: secret=' + (secret ? '[PRESENT]' : '[MISSING]') +
               ', backendApiUrl=' + (backendApiUrl || '[MISSING]') +
               ', userId=' + (userId || '[MISSING]') +
               ', connectionId=' + (connectionId || '[MISSING]'));

    if (!secret || !backendApiUrl || !userId || !connectionId) {
      throw new Error('Missing required parameters in POST body: secret, backendApiUrl, userId, or connectionId');
    }
    
    // Store the secret from the backend for later use in onSheetEdit
    PropertiesService.getScriptProperties().setProperty('API_SECRET_TOKEN', secret);
    
    // STEP 5: Run the main setup logic.
    const setupResult = setup(backendApiUrl, userId, connectionId);

    return ContentService.createTextOutput(JSON.stringify(setupResult))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('Error in doPost: ' + error.toString() + '\\nStack: ' + error.stack);
    response.message = 'Internal error: ' + error.toString();
    response.stack = error.stack; // Include stack for easier debugging
    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Your other functions remain unchanged as their logic is sound.

function testSetup() {
  try {
    Logger.log('=== MANUAL SETUP TEST ===');
    const testBackendApiUrl = 'https://your-backend-url.com';
    const testUserId = 'test-user-id';
    const testConnectionId = 'test-connection-id';
    Logger.log('Testing setup with: backendApiUrl=' + testBackendApiUrl +
               ', userId=' + testUserId + ', connectionId=' + testConnectionId);
    const result = setup(testBackendApiUrl, testUserId, testConnectionId);
    Logger.log('Setup test result: ' + JSON.stringify(result));
    return result;
  } catch (error) {
    Logger.log('Error in testSetup: ' + error.toString());
    return { success: false, message: error.toString() };
  }
}

function setup(backendApiUrl, userId, connectionId) {
  try {
    Logger.log('Starting setup with parameters: backendApiUrl=' + backendApiUrl +
               ', userId=' + userId + ', connectionId=' + connectionId);

    const scriptProperties = PropertiesService.getScriptProperties();
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

    const allTriggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;
    allTriggers.forEach(function(trigger) {
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
        Logger.log('Deleted existing onSheetEdit trigger: ' + trigger.getUniqueId());
      }
    });
    Logger.log('Deleted ' + deletedCount + ' existing triggers');

    const newTrigger = ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(sheetId)
      .onEdit()
      .create();

    Logger.log('Successfully created new onEdit trigger with ID: ' + newTrigger.getUniqueId());
    
    const testResult = testConfiguration();
    Logger.log('Configuration test result: ' + JSON.stringify(testResult));

    return { 
      success: true, 
      message: 'Setup completed successfully. Trigger created.',
      testResult: testResult,
      triggerId: newTrigger.getUniqueId(),
      deletedTriggers: deletedCount
    };

  } catch (error) {
    Logger.log('Error in setup: ' + error.toString() + '\\nStack: ' + error.stack);
    // Re-throw the error so the calling function (doPost) can catch it and format the final response
    throw error;
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('API Sync')
      .addItem('Test Configuration', 'showTestConfiguration')
      .addItem('Manual Setup Test', 'runManualSetupTest')
      .addToUi();
}

function runManualSetupTest() {
  const result = testSetup();
  const message = 'Manual Setup Test Results: ' + JSON.stringify(result, null, 2);
  SpreadsheetApp.getUi().alert('Setup Test Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function showTestConfiguration() {
  const result = testConfiguration();
  const message = 'Configuration Test Results: ' + JSON.stringify(result, null, 2);
  SpreadsheetApp.getUi().alert('Test Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function testConfiguration() {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
    const connectionId = scriptProperties.getProperty('CONNECTION_ID');
    
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const activeSheet = spreadsheet.getActiveSheet();
    
    const allTriggers = ScriptApp.getProjectTriggers();
    const editTriggers = allTriggers.filter(function(t) { return t.getHandlerFunction() === 'onSheetEdit' });
    
    return {
      hasToken: !!secretToken,
      hasUrl: !!backendUrl,
      hasUserId: !!userId,
      hasConnectionId: !!connectionId,
      spreadsheetId: spreadsheet.getId(),
      sheetName: activeSheet.getName(),
      totalTriggers: allTriggers.length,
      editTriggers: editTriggers.length,
      triggerIds: editTriggers.map(function(t) { return t.getUniqueId() })
    };
  } catch (error) {
    Logger.log('Error in testConfiguration: ' + error.toString());
    return { error: error.toString() };
  }
}

function onSheetEdit(e) {
  try {
    Logger.log('onSheetEdit triggered');
    
    if (!e || !e.range) {
      Logger.log('No edit event or range provided, skipping');
      return;
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
    const connectionId = scriptProperties.getProperty('CONNECTION_ID');

    Logger.log('Configuration check: token=' + (secretToken ? '[PRESENT]' : '[MISSING]') +
               ', url=' + (backendUrl || '[MISSING]') +
               ', userId=' + (userId || '[MISSING]') +
               ', connectionId=' + (connectionId || '[MISSING]'));

    if (!secretToken || !backendUrl || !userId || !connectionId) {
      Logger.log('API configuration, userId, or connectionId is missing, skipping edit sync');
      return;
    }

    const API_URL_UPDATE = backendUrl + '/api/update';
    
    const range = e.range;
    const sheet = range.getSheet();
    const startRow = range.getRow();
    const numRows = range.getNumRows();

    Logger.log('Edit detected: sheet=' + sheet.getName() +
               ', startRow=' + startRow + ', numRows=' + numRows);

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const editedRowsData = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();

    Logger.log('Processing ' + numRows + ' edited rows');

    for (var i = 0; i < numRows; i++) {
      const currentRowNumber = startRow + i;
      const currentRowData = editedRowsData[i];

      if (currentRowNumber <= 1) {
        Logger.log('Skipping header row: ' + currentRowNumber);
        continue;
      }
      
      const updatedData = formatDataForSchema(headers, currentRowData, currentRowNumber, userId, connectionId);
      if (!updatedData) {
        Logger.log('Skipping row ' + currentRowNumber + ' as it contains no valid data.');
        continue;
      }

      Logger.log('Sending update for row ' + currentRowNumber + ' with project: ' + updatedData.project_identifier);

      const options = {
        'method': 'post',
        'contentType': 'application/json',
        'headers': { 'Authorization': 'Bearer ' + secretToken },
        'payload': JSON.stringify(updatedData),
        'muteHttpExceptions': true
      };

      try {
        const response = UrlFetchApp.fetch(API_URL_UPDATE, options);
        const responseCode = response.getResponseCode();
        const responseText = response.getContentText();
        
        Logger.log('Update Send (Row ' + currentRowNumber + '): Response Code ' + responseCode);
        Logger.log('Response body: ' + responseText);
        
        if (responseCode >= 400) {
          Logger.log('API request failed for row ' + currentRowNumber + ': ' + responseText);
        }
      } catch (fetchError) {
        Logger.log('HTTP request failed for row ' + currentRowNumber + ': ' + fetchError.toString());
      }
    }
    
    Logger.log('onSheetEdit processing completed');
    
  } catch (error) {
    Logger.log('Error in onSheetEdit: ' + error.toString() + '\\nStack: ' + error.stack);
  }
}

function formatDataForSchema(headers, row, rowIndex, userId, connectionId) {
  try {
    if (!row || !Array.isArray(row)) {
      Logger.log('Invalid row data for row ' + rowIndex);
      return null;
    }
    
    var isEmpty = row.every(function(cell) {
      return cell === "" || cell === null || cell === undefined;
    });

    if (isEmpty) {
      Logger.log('Row ' + rowIndex + ' is completely empty, skipping');
      return null;
    }

    const input_data = {};
    headers.forEach(function(header, i) {
      var key = header ? header.toString().trim() : ('column_' + i);
      if (key && key !== '') {
        input_data[key] = row[i] !== undefined ? row[i] : null;
      }
    });

    var project = input_data["Project"] || 
                  input_data["project"] || 
                  input_data["PROJECT"] ||
                  input_data["Project Name"] ||
                  input_data["project_name"];
    
    if (!project) {
      Logger.log('Row ' + rowIndex + ' has no Project identifier, available keys: ' + Object.keys(input_data).join(', '));
      return null;
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    
    const payload = {
      connectionId: connectionId,
      userId: userId,
      spreadsheet_id: spreadsheet.getId(),
      sheet_range: spreadsheet.getActiveSheet().getName(),
      row_index: rowIndex,
      project_identifier: project.toString(),
      sync_timestamp: new Date().toISOString(),
      input_data: input_data
    };
    
    Logger.log('Formatted data for row ' + rowIndex + ': project=' + project);
    return payload;
    
  } catch (error) {
    Logger.log('Error in formatDataForSchema for row ' + rowIndex + ': ' + error.toString());
    return null;
  }
}
`;

module.exports = { scriptContent };