const scriptContent = `
function onOpen() {
  // Check activation status
  const props = PropertiesService.getScriptProperties();
  const isActivated = props.getProperty('SYNC_ACTIVATED');
  const pendingActivation = props.getProperty('PENDING_ACTIVATION');
  
  // Try to complete pending activation when user opens sheet
  if (pendingActivation === 'true' && !isActivated) {
    try {
      Logger.log('Attempting activation on sheet open...');
      
      // Try to activate now that user has opened the sheet
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      
      // Delete any existing triggers
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(trigger => {
        if (trigger.getHandlerFunction() === 'onSheetEdit') {
          ScriptApp.deleteTrigger(trigger);
        }
      });
      
      // Create new trigger
      ScriptApp.newTrigger('onSheetEdit')
        .forSpreadsheet(spreadsheet)
        .onEdit()
        .create();
      
      // Mark as activated and clear pending flag
      props.setProperty('SYNC_ACTIVATED', 'true');
      props.setProperty('ACTIVATION_TIMESTAMP', new Date().toISOString());
      props.deleteProperty('PENDING_ACTIVATION');
      
      Logger.log('Activation on sheet open successful!');
      
      // Show success message to user
      SpreadsheetApp.getUi().alert(
        'Sheet Sync Activated!', 
        'Your sheet is now automatically syncing with your platform. Any edits will be sent in real-time.',
        SpreadsheetApp.getUi().ButtonSet.OK
      );
      
    } catch (activationError) {
      Logger.log('Activation on open failed: ' + activationError.toString());
      // Fall back to manual activation menu
    }
  }
  
  // Show appropriate menu based on current state
  if (props.getProperty('SYNC_ACTIVATED') === 'true') {
    // Already activated - show status menu
    SpreadsheetApp.getUi()
      .createMenu('Sheet Sync')
      .addItem('Sync Status: Active ✓', 'showSyncStatus')
      .addItem('Deactivate Sync', 'deactivateSync')
      .addToUi();
  } else {
    // Not activated yet - show activation menu
    SpreadsheetApp.getUi()
      .createMenu('Sheet Sync')
      .addItem('Activate Sync', 'activateSync')
      .addToUi();
  }
}

/**
 * Enhanced configuration function with delayed auto-activation
 */
function doPost(e) {
  try {
    Logger.log('=== doPost Called for Configuration ===');
    
    if (!e.postData || !e.postData.contents) {
      throw new Error('No POST data received for configuration');
    }
    
    const payload = JSON.parse(e.postData.contents);
    Logger.log('Payload received: ' + JSON.stringify(payload));
    
    const { secret, backendApiUrl, userId, connectionId, autoActivate = false } = payload;
    
    if (!secret || !backendApiUrl || !userId || !connectionId) {
      throw new Error('Missing required configuration parameters');
    }
    
    // Store configuration in script properties
    const props = PropertiesService.getScriptProperties();
    props.setProperties({
      'API_SECRET_TOKEN': secret,
      'API_BASE_URL': backendApiUrl,
      'PLATFORM_USER_ID': userId,
      'CONNECTION_ID': connectionId
    });
    
    Logger.log('Configuration stored successfully');
    
    let response = {
      success: true,
      message: 'Apps Script configured successfully.'
    };
    
    // Delayed auto-activation approach
    if (autoActivate) {
      try {
        // Mark for pending activation instead of immediate activation
        props.setProperty('PENDING_ACTIVATION', 'true');
        props.setProperty('ACTIVATION_REQUESTED_AT', new Date().toISOString());
        
        // Create a time-based trigger to activate after 3 minutes
        ScriptApp.newTrigger('delayedActivation')
          .timeBased()
          .after(3 * 60 * 1000) // 3 minutes delay
          .create();
        
        response.message = 'Apps Script configured successfully. Auto-activation scheduled for 3 minutes.';
        response.delayedActivation = true;
        response.activationDelay = '3 minutes';
        
        Logger.log('Delayed activation scheduled successfully');
        
      } catch (scheduleError) {
        Logger.log('Failed to schedule delayed activation: ' + scheduleError.toString());
        response.message = 'Apps Script configured but auto-activation scheduling failed. User must activate manually.';
        response.delayedActivation = false;
        response.scheduleError = scheduleError.toString();
      }
    }
    
    return ContentService
      .createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    Logger.log('Error in doPost: ' + error.toString());
    
    const errorResponse = {
      success: false,
      message: error.toString()
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(errorResponse))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Delayed activation function - runs via time-based trigger
 */
function delayedActivation() {
  try {
    Logger.log('=== Delayed Activation Triggered ===');
    
    const props = PropertiesService.getScriptProperties();
    
    // Only proceed if activation is still pending
    if (props.getProperty('PENDING_ACTIVATION') !== 'true') {
      Logger.log('No pending activation found. Exiting.');
      return;
    }
    
    // Check if already activated (maybe user did it manually)
    if (props.getProperty('SYNC_ACTIVATED') === 'true') {
      Logger.log('Already activated. Cleaning up pending flag.');
      props.deleteProperty('PENDING_ACTIVATION');
      return;
    }
    
    Logger.log('Attempting delayed activation...');
    
    // Get the spreadsheet (this should work better after the delay)
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    
    // Clean up any existing triggers first
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    
    // Create the edit trigger
    ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(spreadsheet)
      .onEdit()
      .create();
    
    // Mark as successfully activated
    props.setProperty('SYNC_ACTIVATED', 'true');
    props.setProperty('ACTIVATION_TIMESTAMP', new Date().toISOString());
    props.deleteProperty('PENDING_ACTIVATION');
    
    Logger.log('Delayed activation successful!');
    
    // Clean up this one-time trigger
    const currentTriggers = ScriptApp.getProjectTriggers();
    currentTriggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'delayedActivation') {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    
    Logger.log('Delayed activation trigger cleaned up');
    
  } catch (error) {
    Logger.log('Delayed activation failed: ' + error.toString());
    
    // If delayed activation fails, leave the pending flag so user can activate manually
    const props = PropertiesService.getScriptProperties();
    props.setProperty('DELAYED_ACTIVATION_ERROR', error.toString());
    
    // Clean up the failed trigger anyway
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'delayedActivation') {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  }
}

/**
 * Manual activation function (enhanced with better pending state handling)
 */
function activateSync() {
  try {
    const props = PropertiesService.getScriptProperties();
    
    // Check if already activated
    if (props.getProperty('SYNC_ACTIVATED') === 'true') {
      SpreadsheetApp.getUi().alert('Already Active', 'Sheet Sync is already active!', SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }
    
    // Clean up any pending activation state
    if (props.getProperty('PENDING_ACTIVATION') === 'true') {
      props.deleteProperty('PENDING_ACTIVATION');
      
      // Also clean up any delayed activation triggers
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(trigger => {
        if (trigger.getHandlerFunction() === 'delayedActivation') {
          ScriptApp.deleteTrigger(trigger);
        }
      });
    }
    
    // Delete any existing edit triggers
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // Create the new trigger
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(spreadsheet)
      .onEdit()
      .create();
    
    // Mark as activated
    props.setProperty('SYNC_ACTIVATED', 'true');
    props.setProperty('ACTIVATION_TIMESTAMP', new Date().toISOString());
    
    Logger.log('Successfully created new onEdit trigger via manual activation');

    SpreadsheetApp.getUi().alert('Success!', 'Sheet Sync is now active. Any edits you make will be synced automatically.', SpreadsheetApp.getUi().ButtonSet.OK);

    // Refresh the menu
    onOpen();

  } catch (error) {
    Logger.log('Error in activateSync: ' + error.toString());
    SpreadsheetApp.getUi().alert('Error', 'Failed to activate sync. Error: ' + error.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Show current sync status
 */
function showSyncStatus() {
  const props = PropertiesService.getScriptProperties();
  const activationTime = props.getProperty('ACTIVATION_TIMESTAMP');
  const connectionId = props.getProperty('CONNECTION_ID');
  
  const message = \`Sheet Sync Status: ACTIVE ✓

Activated: \${activationTime ? new Date(activationTime).toLocaleString() : 'Unknown'}
Connection ID: \${connectionId || 'Unknown'}

Your sheet edits are being automatically synced to your platform.\`;

  SpreadsheetApp.getUi().alert('Sync Status', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Deactivate sync (removes trigger)
 */
function deactivateSync() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert('Confirm Deactivation', 
    'Are you sure you want to deactivate Sheet Sync? Your edits will no longer be synced automatically.', 
    ui.ButtonSet.YES_NO);
  
  if (response === ui.Button.YES) {
    try {
      // Delete triggers
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(trigger => {
        if (trigger.getHandlerFunction() === 'onSheetEdit') {
          ScriptApp.deleteTrigger(trigger);
        }
      });
      
      // Update properties
      const props = PropertiesService.getScriptProperties();
      props.deleteProperty('SYNC_ACTIVATED');
      props.deleteProperty('ACTIVATION_TIMESTAMP');
      
      ui.alert('Deactivated', 'Sheet Sync has been deactivated.', ui.ButtonSet.OK);
      
      // Refresh menu
      onOpen();
      
    } catch (error) {
      ui.alert('Error', 'Failed to deactivate sync: ' + error.message, ui.ButtonSet.OK);
    }
  }
}

/**
 * Main sync function - runs on every edit
 */
function onSheetEdit(e) {
  try {
    if (!e || !e.range) {
      return;
    }
    
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('API_SECRET_TOKEN');
    const apiUrl = props.getProperty('API_BASE_URL');
    const userId = props.getProperty('PLATFORM_USER_ID');
    const connectionId = props.getProperty('CONNECTION_ID');
    
    if (!secret || !apiUrl || !userId || !connectionId) {
      Logger.log('Configuration missing. Cannot sync edit.');
      return;
    }
    
    const range = e.range;
    const sheet = range.getSheet();
    const row = range.getRow();
    
    // Skip header row edits
    if (row <= 1) {
      return;
    }
    
    // Get headers and row data
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    const input_data = {};
    headers.forEach((header, i) => {
      const key = header ? header.toString().trim() : 'column_' + i;
      if (key) {
        input_data[key] = rowData[i] !== undefined ? rowData[i] : null;
      }
    });
    
    const projectIdentifier = input_data["Project"] || "Unnamed Project";
    
    const updateData = {
      connectionId: connectionId,
      userId: userId,
      spreadsheet_id: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheet_range: sheet.getName(),
      row_index: row,
      project_identifier: projectIdentifier.toString(),
      sync_timestamp: new Date().toISOString(),
      input_data: input_data
    };
    
    const options = {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + secret
      },
      payload: JSON.stringify(updateData),
      muteHttpExceptions: true
    };
    
    UrlFetchApp.fetch(apiUrl + '/api/update', options);
    
  } catch (error) {
    Logger.log('Error in onSheetEdit: ' + error.toString());
  }
}
`;

module.exports = { scriptContent };