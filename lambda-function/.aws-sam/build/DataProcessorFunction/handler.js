import { OpenAI } from "openai"; // The OpenAI library is compatible with Groq's API
import { MongoClient } from "mongodb";
import { z } from "zod";
import { dedent } from "ts-dedent";

const logger = console;

// --- Schemas (No changes needed here) ---
const SqsPayloadSchema = z.object({
  spreadsheet_id: z.string().min(1, { message: "Spreadsheet ID is required." }),
  sheet_range: z.string().min(1, { message: "Sheet range is required." }),
  row_index: z.number().int().positive(),
  project_identifier: z.string(),
  sync_timestamp: z.string().datetime(),
  input_data: z.record(z.any()),
});

const AiPredictionSchema = z.object({
  Risk: z.string(),
  Issues: z.string(),
  Forecasted_Cost: z.number(),
  Forecasted_Deviation: z.number(),
  Burnout_Risk: z.number(),
});

const MongoDbSchema = z.object({
  spreadsheet_id: z.string(),
  row_index: z.number(),
  project_identifier: z.string(),
  sync_timestamp: z.string().datetime(),
  source_data: z.object({
    Program: z.any().optional(),
    Portfolio: z.any().optional(),
    "Project Manager": z.any().optional(),
    Vendor: z.any().optional(),
    "Contract ID": z.any().optional(),
    "Contract Start Date": z.any().optional(),
    "Contract End Date": z.any().optional(),
    "Contract Ceiling Price": z.any().optional(),
    "Contract Target Price": z.any().optional(),
    "Actual Contract Spend": z.any().optional(),
    "Expiring Soon": z.any().optional(),
    "Resource Name": z.any().optional(),
    Role: z.any().optional(),
    "Allocated Hours": z.any().optional(),
    "Actual Hours": z.any().optional(),
    "Planned Cost": z.any().optional(),
    "Actual Cost": z.any().optional(),
    "Update Date": z.any().optional(),
  }).passthrough(false),
  ai_predictions: AiPredictionSchema,
  last_processed_at: z.string().datetime(),
});


// --- Environment Variable Loading (Updated for Groq) ---
const {
  GROQ_API_KEY, // CHANGED
  MONGO_URI,
  DB_NAME,
  PROCESSED_DATA_COLLECTION,
  GROQ_MODEL = "llama3-8b-8192", // CHANGED to a Groq model
  MAX_RETRIES = "3",
  RETRY_BASE_DELAY = "1.0",
} = process.env;

if (!GROQ_API_KEY || !MONGO_URI || !DB_NAME || !PROCESSED_DATA_COLLECTION) {
  throw new Error("FATAL: Missing one or more essential environment variables.");
}

const maxRetries = parseInt(MAX_RETRIES, 10);
const retryBaseDelay = parseFloat(RETRY_BASE_DELAY);


// --- Client Initialization (Updated for Groq) ---
const groqClient = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1", // This is the required change for Groq
});
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
let db;


// --- AI Prompt (No changes needed) ---
const pm_ai_prompt = dedent`...`; // Your full prompt here


// --- Utility & Service Functions ---

const exponentialBackoffSleep = (attempt, baseDelay = retryBaseDelay) => { /* ... no changes ... */ };
const testMongodbConnection = async () => { /* ... no changes ... */ };

// --- Function to get AI predictions (Updated for Groq) ---
const getAiPredictionsWithRetry = async (inputData) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await groqClient.chat.completions.create({ // CHANGED to groqClient
        model: GROQ_MODEL, // CHANGED to GROQ_MODEL
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: pm_ai_prompt },
          { role: "user", content: JSON.stringify(inputData, null, 2) },
        ],
      });
      const responseContent = completion.choices[0].message.content;
      return AiPredictionSchema.parse(JSON.parse(responseContent));
    } catch (error) {
      logger.warn(`Groq API attempt ${attempt + 1} failed: ${error.message}`); // Updated log message
      if (attempt < maxRetries - 1) {
        await exponentialBackoffSleep(attempt);
      } else {
        throw new Error("All Groq API attempts failed."); // Updated error message
      }
    }
  }
  return null;
};

const storeDocumentWithRetry = async (document, upsertKey) => { /* ... no changes ... */ };
const processSingleRecord = async (record) => { /* ... no changes ... */ };
export const handler = async (event) => { /* ... no changes ... */ };
