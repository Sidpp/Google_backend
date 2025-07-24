const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { bulkImportSchema, updateSchema } = require("../backend-api/utils/validator"); // <-- IMPORTED HERE

const sqsClient = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const BULK_IMPORT_QUEUE_URL = process.env.BULK_IMPORT_QUEUE_URL;
const UPDATE_QUEUE_URL = process.env.UPDATE_QUEUE_URL;

async function sendBulkImportMessages(dataArray) {
    if (!BULK_IMPORT_QUEUE_URL) throw new Error("BULK_IMPORT_QUEUE_URL not configured.");
    console.log(`--- Preparing to send ${dataArray.length} rows to SQS ---`);

    let successfullySentCount = 0;
    for (const row of dataArray) {
        try {
            bulkImportSchema.parse(row);

            const params = {
                QueueUrl: BULK_IMPORT_QUEUE_URL,
                MessageBody: JSON.stringify(row),
            };

            await sqsClient.send(new SendMessageCommand(params));
            successfullySentCount++;
        } catch (error) {
            // Catch both validation and SQS errors
            console.error("Error processing row:", JSON.stringify(row, null, 2));
            console.error("Error Details:", error.name, error.message);
        }
    }
    console.log(` Finished SQS send process. Successfully sent ${successfullySentCount}/${dataArray.length} messages.`);
}

async function sendUpdateMessage(updatedData) {
    if (!UPDATE_QUEUE_URL) throw new Error("UPDATE_QUEUE_URL not configured.");

    try {
        // VALIDATION ADDED HERE: Validate the data before sending.
        updateSchema.parse(updatedData);

        const params = {
            QueueUrl: UPDATE_QUEUE_URL,
            MessageBody: JSON.stringify(updatedData),
        };

        await sqsClient.send(new SendMessageCommand(params));
        console.log(` Sent update to SQS: ${updatedData.project_identifier}`);
    } catch (error) {
        // Catch both validation and SQS errors
        console.error("Error sending SQS update:", error.name, error.message);
    }
}

module.exports = { sendBulkImportMessages, sendUpdateMessage };