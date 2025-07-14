const express = require('express');
const { sendBulkImportMessages, sendUpdateMessage } = require('../sqs-service');
const { bulkImportSchema, updateSchema } = require('../utils/validator');

const router = express.Router();

router.post('/bulk-import', async (req, res) => {
  try {
    bulkImportSchema.parse(req.body);
    await sendBulkImportMessages(req.body.data);
    res.status(202).json({ message: '✅ Bulk data queued' });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(400).json({ message: err.errors?.[0]?.message || 'Validation failed'});
  }
});

router.post('/update', async (req, res) => {
  try {
    updateSchema.parse(req.body);
    await sendUpdateMessage(req.body);
    res.status(202).json({ message: 'Update queued' });
  } catch (err) {
    console.error('Update error:', err);
    res.status(400).json({ message: err.errors?.[0]?.message || 'Validation failed' });
  }
});

module.exports = router;
