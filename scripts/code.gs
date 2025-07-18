/**
 * A single function called by the Node.js backend to perform all initial setup.
 * This is more efficient as it only requires one 'scripts.run' call.
 * @param {string} secret The secret token for API authorization.
 * @param {string} backendApiUrl The public base URL of your backend.
 */
function setupFromBackend(secret, backendApiUrl) {
  try {
    Logger.log('Starting setupFromBackend with parameters:', { secret: secret ? '***' : 'undefined', backendApiUrl });
    
    // Validate inputs
    if (!secret || !backendApiUrl) {
      throw new Error('Missing required parameters: secret or backendApiUrl');
    }
    
    // Set the properties
    const scriptProperties = PropertiesService.getScriptProperties();
    scriptProperties.setProperties({
      'API_SECRET_TOKEN': secret,
      'API_BASE_URL': backendApiUrl
    });
    Logger.log('Successfully set API secret and backend URL.');
    
    // Verify the spreadsheet is accessible
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Could not access the active spreadsheet');
    }
    
    const sheetId = spreadsheet.getId();
    Logger.log('Working with spreadsheet ID:', sheetId);
    
    // Clean up existing triggers first
    const allTriggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;
    
    for (const trigger of allTriggers) {
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      Logger.log(`Deleted ${deletedCount} existing onSheetEdit triggers.`);
    }
    
    // Create new trigger
    const newTrigger = ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(sheetId)
      .onEdit()
      .create();
      
    Logger.log('Successfully created onEdit trigger with ID:', newTrigger.getUniqueId());
    
    // Test the configuration by attempting to format some test data
    const testResult = testConfiguration();
    Logger.log('Configuration test result:', testResult);
    
    Logger.log('Setup completed successfully');
    return { success: true, message: 'Setup completed successfully' };
    
  } catch (error) {
    Logger.log('Error in setupFromBackend:', error.toString());
    throw error;
  }
}

/**
 * Test function to verify the configuration works
 */
function testConfiguration() {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    
    return {
      hasToken: !!secretToken,
      hasUrl: !!backendUrl,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()
    };
  } catch (error) {
    return { error: error.toString() };
  }
}

/**
 * Creates a custom menu in the Google Sheet UI when the spreadsheet is opened.
 * This is useful for manual testing and debugging.
 */
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

/**
 * Show current configuration for debugging
 */
function showCurrentConfig() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
  const backendUrl = scriptProperties.getProperty('API_BASE_URL');
  
  const message = `Current Configuration:
API URL: ${backendUrl || 'Not set'}
API Token: ${secretToken ? 'Set (****)' : 'Not set'}
Spreadsheet ID: ${SpreadsheetApp.getActiveSpreadsheet().getId()}
Sheet Name: ${SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()}`;
  
  SpreadsheetApp.getUi().alert('Current Configuration', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Show test configuration results
 */
function showTestConfiguration() {
  const result = testConfiguration();
  const message = `Configuration Test Results:
${JSON.stringify(result, null, 2)}`;
  
  SpreadsheetApp.getUi().alert('Test Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Manually prompts the user for the API configuration. Only needed for debugging.
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
      const scriptProperties = PropertiesService.getScriptProperties();
      scriptProperties.setProperties({
        'API_SECRET_TOKEN': token,
        'API_BASE_URL': url
      });
      ui.alert('✅ Success', 'Manual API config has been saved.', ui.ButtonSet.OK);
    } else {
      ui.alert('Error', 'Invalid format. Please provide both URL and Token.', ui.ButtonSet.OK);
    }
  }
}

/**
 * Sends all data from the active sheet to the backend's /api/bulk-import endpoint.
 * It automatically handles batching to stay within Google's payload size limits.
 */
function sendAllData() {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');
    
    if (!secretToken || !backendUrl) {
      SpreadsheetApp.getUi().alert('❌ Configuration Missing', 
        'API configuration is missing. Please re-authenticate from the main application to set it up.', 
        SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }
    
    const API_URL_BULK = backendUrl + '/api/bulk-import';
    
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const allSheetData = sheet.getDataRange().getValues();
    
    if (allSheetData.length <= 1) {
      SpreadsheetApp.getUi().alert('ℹ️ No data to send', 'Sheet contains only headers or is empty.', SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }
    
    const headers = allSheetData[0];
    const dataRows = allSheetData.slice(1);

    const jsonData = dataRows
      .map((row, index) => formatDataForSchema(headers, row, index + 2))
      .filter(item => item !== null);

    if (jsonData.length === 0) {
      SpreadsheetApp.getUi().alert('ℹ️ No valid data to send', 
        'No rows contain valid project data.', 
        SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }

    const batchSize = 100; // Reduced batch size for better reliability
    let totalSent = 0;
    let errors = [];
    
    for (let i = 0; i < jsonData.length; i += batchSize) {
      const batch = jsonData.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      
      try {
        const options = {
          'method': 'post',
          'contentType': 'application/json',
          'headers': { 'Authorization': 'Bearer ' + secretToken },
          'payload': JSON.stringify({ data: batch }),
          'muteHttpExceptions': true
        };
        
        const response = UrlFetchApp.fetch(API_URL_BULK, options);
        const responseCode = response.getResponseCode();
        
        Logger.log(`Bulk Send (Batch ${batchNumber}): Response Code ${responseCode}`);
        
        if (responseCode >= 200 && responseCode < 300) {
          totalSent += batch.length;
        } else {
          errors.push(`Batch ${batchNumber}: HTTP ${responseCode}`);
          Logger.log(`Batch ${batchNumber} failed: ${response.getContentText()}`);
        }
        
      } catch (error) {
        errors.push(`Batch ${batchNumber}: ${error.toString()}`);
        Logger.log(`Batch ${batchNumber} error:`, error);
      }
    }

    let message = `✅ Bulk send completed!\nSent: ${totalSent} rows`;
    if (errors.length > 0) {
      message += `\nErrors: ${errors.length} batches failed`;
    }
    
    SpreadsheetApp.getUi().alert('Bulk Send Results', message, SpreadsheetApp.getUi().ButtonSet.OK);
    
  } catch (error) {
    Logger.log('Error in sendAllData:', error);
    SpreadsheetApp.getUi().alert('❌ Error', 
      'An error occurred while sending data: ' + error.toString(), 
      SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * An installable trigger that runs automatically when a user edits the spreadsheet.
 * Sends the data of the edited row to the /api/update endpoint.
 * @param {Object} e The event object from the onEdit trigger.
 */
function onSheetEdit(e) {
  try {
    // Basic validation
    if (!e || !e.range) {
      Logger.log('Invalid edit event received');
      return;
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    const secretToken = scriptProperties.getProperty('API_SECRET_TOKEN');
    const backendUrl = scriptProperties.getProperty('API_BASE_URL');

    if (!secretToken || !backendUrl) {
      Logger.log('API configuration missing, skipping edit sync');
      return;
    }

    const API_URL_UPDATE = backendUrl + '/api/update';
    
    const range = e.range;
    const sheet = range.getSheet();
    const rowNumber = range.getRow();
    
    // Skip header row
    if (rowNumber <= 1) {
      Logger.log('Edit was in header row, skipping');
      return;
    }
    
    // Get headers and edited row data
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const editedRowData = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    const updatedData = formatDataForSchema(headers, editedRowData, rowNumber);
    if (!updatedData) {
      Logger.log('No valid data to sync for edited row');
      return;
    }

    const options = {
      'method': 'post',
      'contentType': 'application/json',
      'headers': { 'Authorization': 'Bearer ' + secretToken },
      'payload': JSON.stringify(updatedData),
      'muteHttpExceptions': true
    };

    const response = UrlFetchApp.fetch(API_URL_UPDATE, options);
    const responseCode = response.getResponseCode();
    
    Logger.log(`Update Send (Row ${rowNumber}): Response Code ${responseCode}`);
    
    if (responseCode < 200 || responseCode >= 300) {
      Logger.log(`Update failed: ${response.getContentText()}`);
    }
    
  } catch (error) {
    Logger.log('Error in onSheetEdit:', error.toString());
  }
}

/**
 * Converts a row array into a structured JavaScript object using headers as keys.
 * @param {string[]} headers The array of header names from the first row.
 * @param {Array} row The array of cell values for a single row.
 * @param {number} rowIndex The actual row number from the sheet.
 * @returns {Object|null} A formatted object, or null if the row is empty.
 */
function formatDataForSchema(headers, row, rowIndex) {
  try {
    if (!row || !Array.isArray(row) || row.every(cell => cell === "" || cell === null || cell === undefined)) {
      return null;
    }

    const input_data = {};
    headers.forEach((header, i) => {
      const key = header ? header.toString().trim() : `column_${i}`;
      if (key && key !== '') {
        input_data[key] = row[i] !== undefined ? row[i] : null;
      }
    });

    // Check if we have a Project identifier
    const project = input_data["Project"] || input_data["project"] || input_data["PROJECT"];
    if (!project) {
      Logger.log(`Row ${rowIndex} has no Project identifier, skipping`);
      return null;
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const spreadsheet_id = spreadsheet.getId();
    const sheet_name = spreadsheet.getActiveSheet().getName();
    const range = `${sheet_name}!A1:AZ1000`;

    return {
      spreadsheet_id,
      sheet_range: range,
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