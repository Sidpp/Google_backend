const express = require('express');
const { sendUpdateMessage } = require('../sqs-service');
const router = express.Router();

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
