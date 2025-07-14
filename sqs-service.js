const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

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
        const params = {
            QueueUrl: BULK_IMPORT_QUEUE_URL,
            MessageBody: JSON.stringify(row),
        };

        try {
            //  Log the data before sending
            console.log("Sending row:", JSON.stringify(row, null, 2));

            await sqsClient.send(new SendMessageCommand(params));
            successfullySentCount++;
        } catch (error) {
            // Catch and log any error from AWS
            console.error("AWS SQS Send Error:", error.name, error.message);
            console.error("Error occurred for row:", JSON.stringify(row, null, 2));
            // Optional: stop on first error
            // break; 
        }
    }
    console.log(` Finished SQS send process. Successfully sent ${successfullySentCount}/${dataArray.length} messages.`);
}

async function sendUpdateMessage(updatedData) {
    if (!UPDATE_QUEUE_URL) throw new Error("UPDATE_QUEUE_URL not configured.");

    const params = {
        QueueUrl: UPDATE_QUEUE_URL,
        MessageBody: JSON.stringify(updatedData),
    };

    try {
        await sqsClient.send(new SendMessageCommand(params));
        console.log(` Sent update to SQS: ${updatedData.project_identifier}`);
    } catch (error) {

        console.error(" AWS SQS Send Error:", error.name, error.message);
    }
}

module.exports = { sendBulkImportMessages, sendUpdateMessage };