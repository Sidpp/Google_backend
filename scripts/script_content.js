const scriptContent = `
function setupFromBackend(secret, backendApiUrl, userId) {
  try {
    Logger.log('Starting setupFromBackend with parameters:', { secret: '***', backendApiUrl, userId });
    
    if (!secret || !backendApiUrl || !userId) {
      throw new Error('Missing required parameters: secret, backendApiUrl, or userId');
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    scriptProperties.setProperties({
      'API_SECRET_TOKEN': secret,
      'API_BASE_URL': backendApiUrl,
      'PLATFORM_USER_ID': userId
    });
    Logger.log('Successfully set API config and PLATFORM_USER_ID.');
    
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Could not access the active spreadsheet');
    }
    
    const sheetId = spreadsheet.getId();
    Logger.log('Working with spreadsheet ID:', sheetId);
    
    const allTriggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;
    
    for (const trigger of allTriggers) {
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      Logger.log(\`Deleted \${deletedCount} existing onSheetEdit triggers.\`);
    }
    
    const newTrigger = ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(sheetId)
      .onEdit()
      .create();
      
    Logger.log('Successfully created onEdit trigger with ID:', newTrigger.getUniqueId());
    
    const testResult = testConfiguration();
    Logger.log('Configuration test result:', testResult);
    
    Logger.log('Setup completed successfully');
    return { success: true, message: 'Setup completed successfully' };
    
  } catch (error) {
    Logger.log('Error in setupFromBackend:', error.toString());
    throw error;
  }
}

function testConfiguration() {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
    
    return {
      hasToken: !!secretToken,
      hasUrl: !!backendUrl,
      hasUserId: !!userId,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()
    };
  } catch (error) {
    return { error: error.toString() };
  }
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
        .createMenu('API Sync')
        .addItem('Test Configuration', 'showTestConfiguration')
        .addSeparator()
        .addItem('(Manual) Set API Config', 'setupManualConfig')
        .addItem('Show Current Config', 'showCurrentConfig')
        .addToUi();
  } catch (error) {
    Logger.log('Error creating menu:', error.toString());
  }
}

function showCurrentConfig() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('API_BASE_URL');
  const userId = scriptProperties.getProperty('PLATFORM_USER_ID');
  
  const message = \`Current Configuration:
API URL: \${backendUrl || 'Not set'}
API Token: \${secretToken ? 'Set (****)' : 'Not set'}
User ID: \${userId || 'Not set'}
Spreadsheet ID: \${SpreadsheetApp.getActiveSpreadsheet().getId()}
Sheet Name: \${SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()}\`;
  
  SpreadsheetApp.getUi().alert('Current Configuration', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function showTestConfiguration() {
  const result = testConfiguration();
  const message = \`Configuration Test Results:
\${JSON.stringify(result, null, 2)}\`;
  
  SpreadsheetApp.getUi().alert('Test Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function setupManualConfig() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Manual API Config',
    'Enter API URL, Token, and UserID, separated by commas (e.g., https://my-app.com,my-secret,user-id)',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.OK) {
    const [url, token, userId] = response.getResponseText().split(',').map(s => s.trim());
    if (url && token && userId) {
      const scriptProperties = PropertiesService.getScriptProperties();
      scriptProperties.setProperties({
        'API_SECRET_TOKEN': token,
        'API_BASE_URL': url,
        'PLATFORM_USER_ID': userId
      });
      ui.alert('✅ Success', 'Manual API config has been saved.', ui.ButtonSet.OK);
    } else {
      ui.alert('Error', 'Invalid format. Please provide URL, Token, and UserID.', ui.ButtonSet.OK);
    }
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

    if (!secretToken || !backendUrl || !userId) {
      Logger.log('API configuration or userId is missing, skipping edit sync');
      return;
    }

    const API_URL_UPDATE = backendUrl + '/api/update';
    
    const range = e.range;
    const sheet = range.getSheet();
    const startRow = range.getRow();
    const numRows = range.getNumRows();

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const editedRowsData = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();

    for (let i = 0; i < numRows; i++) {
      const currentRowNumber = startRow + i;
      const currentRowData = editedRowsData[i];

      if (currentRowNumber <= 1) {
        continue;
      }
      
      const updatedData = formatDataForSchema(headers, currentRowData, currentRowNumber, userId);
      if (!updatedData) {
        Logger.log(\`Skipping row \${currentRowNumber} as it contains no valid data.\`);
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
      Logger.log(\`Update Send (Row \${currentRowNumber}): Response Code \${response.getResponseCode()}\`);
    }
    
  } catch (error) {
    Logger.log('Error in onSheetEdit:', error.toString());
  }
}

function formatDataForSchema(headers, row, rowIndex, userId) {
  try {
    if (!row || !Array.isArray(row) || row.every(cell => cell === "" || cell === null || cell === undefined)) {
      return null;
    }

    const input_data = {};
    headers.forEach((header, i) => {
      const key = header ? header.toString().trim() : \\\`column_\\\${i}\\\`; // <-- FIXED HERE
      if (key && key !== '') {
        input_data[key] = row[i] !== undefined ? row[i] : null;
      }
    });

    const project = input_data["Project"] || input_data["project"] || input_data["PROJECT"];
    if (!project) {
      Logger.log(\`Row \${rowIndex} has no Project identifier, skipping\`);
      return null;
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    
    return {
      userId: userId,
      spreadsheet_id: spreadsheet.getId(),
      sheet_range: spreadsheet.getActiveSheet().getName(),
      row_index: rowIndex,
      project_identifier: project,
      sync_timestamp: new Date().toISOString(),
      input_data
    };
    
  } catch (error) {
    Logger.log('Error in formatDataForSchema:', error);
    return null;
  }
}
`;

module.exports = { scriptContent };