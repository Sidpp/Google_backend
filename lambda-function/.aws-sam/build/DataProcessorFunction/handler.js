import Groq from "groq-sdk";
import { MongoClient } from "mongodb";
import { z } from "zod";
import { dedent } from "ts-dedent";

const logger = console;

const SqsPayloadSchema = z.object({
  userId :z.string().min(1,{message:"User ID is required in the SQS message"}),
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
  userId:z.instanceof(Object(Id)),
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

const {
  GROQ_API_KEY,
  MONGO_URI,
  DB_NAME,
  PROCESSED_DATA_COLLECTION = "GoogleSheet",
  LLAMA_MODEL = "llama3-8b-8192", // Using Llama model with Groq
  MAX_RETRIES = "3",
  RETRY_BASE_DELAY = "1.0",
} = process.env;

if (!MONGO_URI || !DB_NAME || !GROQ_API_KEY) {
  throw new Error("FATAL: Missing one or more essential environment variables (MONGO_URI, DB_NAME, GROQ_API_KEY).");
}

const maxRetries = parseInt(MAX_RETRIES, 10);
const retryBaseDelay = parseFloat(RETRY_BASE_DELAY);

const groqClient = new Groq({ apiKey: GROQ_API_KEY });
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
let db;

const initializeMongoDB = async () => {
  try {
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 1,
        retryWrites: true,
        w: 'majority'
      });

      await mongoClient.connect();
      logger.info("MongoDB client connected successfully");
    }

    if (!db) {
      db = mongoClient.db(DB_NAME);
      logger.info(`Connected to database: ${DB_NAME}`);
    }

    return true;
  } catch (error) {
    logger.error(`Failed to initialize MongoDB: ${error.message}`);
    throw error;
  }
};

// --- AI Prompt (remains unchanged as it's for the LLM) ---
const pm_ai_prompt = dedent`
You are an AI Project Risk Analyst specializing in Google sheet

### Input Data Structure
{
"Program": "program name",
"Portfolio": "portfolio name",
"Project": "project name",
"Project Manager": "project_manager",
"Vendor": "vendor name",
"Contract ID": "contract_id",
  "Contract Ceiling Price": "ceiling_price",
  "Contract Target Price": "target_price",
  "Actual Contract Spend": "actual_spend",
  "Expiring Soon": "expiring_soon",
  "Contract Start Date": "contract_start_date",
  "Contract End Date": "contract_end_date",
  "Resource Name": "resource_name",
  "Role": "role",
  "Planned Cost": "planned_cost",
  "Actual Cost": "actual_cost",
  "Update Date": "update_date",
  "Allocated Hours": "allocated_hours",
  "Actual Hours": "actual_hours",
  "Milestone Status": "milestone_status"
}

### Output Requirements
Return a valid JSON object with these exact keys:
{
  "Risk": "<Resource Constraints|Vendor Delay|Scope Creep|Tech Debt>",
  "Issues": "<Budget cut|Requirement gap|Overtime reported|Escalation pending>",
  "Forecasted_Cost": <$xx,xxx>,
  "Forecasted_Deviation": < $±xx,xxx>,
  "Burnout":<%x.x>
}

###Tasks
1 **Risk**:Classify as one of:
  -'" Resource Constraints"'(Understanding when you should choose "Resource Consarints"
If Actual Hours exceeds Allocated Hours by more than 10%, the project may be suffering from under-resourcing or overwork.
Extract the values from the given json format Actual Hours and Allocated Hours then put those values into the formulae Utlization Ratio=Actual Hours/Allocated Hours
Know the condition Utilization Ratio > 1.10 → Flag as overutilized      This suggests either:   The assigned resources are inadequate, orTasks are underestimated, requiring more effort from the existing team.  Contractual or Time Pressure Projects close to or past their planned end date increase pressure on teams to deliver within constrained timelines. Extract the expiring Soon and the update date ,Rule:
If the project is flagged as "Expiring Soon" or the "Update Date" is after the Contract End Date, the risk is amplified,These conditions typically lead to:Overtime work,Compromised quality,Team burnout.Cost Alignment Supports Resource Risk, Not Scope Expansion Observation:If the project is under budget, yet team members are overutilized, it's unlikely the problem is scope creep or tech debt.This contrast indicates that the scope hasn’t necessarily changed — but existing resources are overburdened, possibly due to: Inefficient task distribution ,Resource attrition or unavailability ,Inadequate resourcing planning Conclusion (Logic Summary) A project is likely at risk of Resource Constraints if:  Actual hours exceed allocated hours by 10% or more,The project is nearing its contract end date or flagged as expiring,There is no evidence of overspending or feature expansion

  -'"Tech Debt"'(Rule logic for "Technical Debt"
To detect signals of technical debt accumulation—the result of trade-offs made during system design or development that lead to long-term inefficiencies, instability, or rework.
Prediction Logic – Technical Debt
1)Repeated or Prolonged Milestone Delays
Indicators:
Milestone Status = "Incomplete", "In Progress", or “Delayed”
Multiple extensions or reschedules (implied by Update Date > Contract End Date)
Why it matters:
Tech debt causes repeated slips in delivery — because unresolved foundational issues (bad architecture, fragile code, shortcuts) require rework or debugging at every step.
if milestone_status != "Completed" and update_date > contract_end_date:
    tech_debt_risk += medium
2. CPI + SPI Divergence → Instability
 Indicators:
CPI (Cost Performance Index) fluctuates (e.g. < 0.85 or varies month-to-month)
SPI (Schedule Performance Index) is inconsistent
Why it matters:
Tech debt creates project "drag" — poor performance consistency. Teams spend extra time/money on fragile systems, producing unpredictable progress.
Logic Rule:
if cpi < 0.9 and abs(cpi - spi) > 0.1:
    tech_debt_risk += high
3. Low Resource Efficiency (More Hours, No Progress)
 Indicators:
Actual Hours > Allocated Hours
Yet: Planned Cost ≈ Actual Cost (or under budget)
Or: Milestones not advancing
Why it matters:
Team is burning more effort but not delivering correspondingly. This suggests inefficiency — e.g., unstable builds, rework loops, excessive bug fixing — all signs of tech debt.
Logic Rule:
if actual_hours > allocated_hours and milestone_status != "Completed":
    tech_debt_risk += medium
Expiring Projects with Incomplete Deliverables
🔍 Indicators:
Expiring Soon = True
Yet key milestone_status is incomplete
Or: Testing/resource-heavy roles (like QA, DevOps) are overutilized
Why it matters:
Tech debt commonly leads to unfinished technical obligations (e.g. testing debt, automation gaps, infra problems) that delay closure.
5. Low Actual Cost with High Hours → Tooling/Tech Problems
Indicators:
Actual Cost under budget
But Actual Hours significantly over
QA, Engineer, DevOps roles overworked
Why it matters:
If effort is high, but cost is low, it may imply manual effort, firefighting, or unplanned debugging — classic symptoms of poor tooling or tech bottlenecks.)
  -'"Vendor delay "'(Prediction Logic – Vendor Delay
1. Missed Milestones on Vendor-Sourced Work
 Indicators:
Milestone Status = “In Progress” or “Delayed”
Contract End Date approaching or exceeded
Milestone owner/role is external (e.g., vendor QA, vendor development)
Why it matters:
Vendors often own deliverables (code, data, infra). When those milestones are incomplete near the deadline, it flags a third-party delivery delay.
if milestone_status != "Completed" and role contains "Vendor" and expiring_soon:
    vendor_delay_risk += high
2. Unspent Budget Despite Project Age
 Indicators:
Actual Contract Spend is much lower than Target Price
Update Date is close to or past Contract End Date
Why it matters:
Low spend near project completion usually means vendor hasn’t delivered, submitted invoices, or triggered payments — a red flag for inactivity or delayed fulfillment.
Logic Rule:
if actual_spend < (target_price * 0.7) and update_date >= (contract_end_date - 30 days):
    vendor_delay_risk += medium
3. Over-Allocated Internal Resources on Vendor-Dependent Work
 Indicators:
Internal roles (PMs, QA, integrators) show high actual hours
Yet vendor-owned components are incomplete
Why it matters:
Internal teams may be idling, waiting for vendors — leading to effort wastage and overburn without output.
Logic Rule:
if actual_hours > allocated_hours and milestone_status != "Completed" and vendor is active:
    vendor_delay_risk += medium
4. Multiple Change Orders or Contract Extensions
 Indicators:
Frequent Contract End Date changes
Budget increases (Ceiling Price grows over time)
Delayed deliverables tied to external commitments
Why it matters:
Changes in scope or date related to external dependencies often signal contractual slippage or misaligned expectations with vendors.
Logic Rule:
if ceiling_price or end_date increased more than once:
    vendor_delay_risk += medium
5. No Progress Despite Active Vendor Role
 Indicators:
Vendor-related resource active (e.g., QA from "Vendor X")
But Actual Hours or milestone progress is near-zero
Why it matters:
When a vendor is assigned work but no visible progress is made (low hours, low spend), this signals delays in mobilization or delivery.)
  -'" Scope Creep"'(Understanding when you should choose Scope Creep
Theoretical Framework for Predicting Project Risks: Scope Creep
To identify if a project is likely suffering from scope creep, which is the uncontrolled expansion of project work without corresponding adjustments in time, cost, or resources.
Prediction Logic – Scope Creep   Cost Overrun with Effort or Time Mismatch Indicators:
Actual Cost > Planned CostActual Hours > Allocated Hours and/or Contract End Date exceeded
Why it matters:
When you're spending more or working more hours than planned without changes to the project baseline, it's a leading indicator of unapproved scope growth.
Logic Rule:
if actual_cost > planned_cost and actual_hours > allocated_hours:
    scope_creep_risk += high
2. Milestone Delays or Rework
 Indicators:
Milestone Status ≠ “Completed” despite being near or past end date
Update Date > Contract End Date
Multiple reassignments or time extensions (if tracked)
Why it matters:
Scope creep often delays milestones, especially in software or consulting projects. Deliverables keep evolving, pushing deadlines.
Example:
If cost increased but deliverables didn't officially change, that means extra features/tasks are being absorbed without proper change control.
if milestone_status != "Completed" and update_date > contract_end_date:
    scope_creep_risk += medium
3. Underreported Risks + Hidden Work
 Indicators:
No major risks/issues listed
Costs/effort increasing without any documented cause
Why it matters:
When cost and timeline are drifting but risk logs don’t reflect corresponding causes (like vendor failure or attrition), it suggests scope additions are being absorbed informally.
Logic Rule:
if cost/effort increases and risks == "None" and issues == "None":
    scope_creep_risk += medium
 Low CPI + Neutral SPI → Creep Pattern
 Indicators:CPI < 1.0 (cost performance slipping)
SPI ≈ 1.0 (schedule looks OK)Why it matters:
A project delivering “on time” but at increased cost is classic scope creep: teams are doing more without getting more time, just absorbing the extra work.
if cpi < 1.0 and 0.95 <= spi <= 1.05:
    scope_creep_risk += high)
)


2) ####***Issues****
    -- Overtime Reported if
               (Actual Hours>Allocated Hours,Planned cost>Actual Cost High effort but low cost is a paradox — and a classic overtime signal.It suggests that the extra hours were not officially compensated.
             Fixed-rate salaried staff worked extra,Time was borrowed from other projects,Hidden productivity tax on the team,In short: more work, same or less money = burnout, not better efficiency  if update date > Contract End date
             Deliverables were finished, but likely under timeline stress,This gap shows project closure happened past the contract timeline, often a result of:,Accumulated delays,Squeezed timelines toward the end,Internal push to “just finish it”
               )
    --  Budget Cut(A “Budget Cut” refers to a reduction in the available financial resources allocated to a project. It typically occurs due to persistent underutilization of funds, organizational reprioritization, or early delivery with excess budget remaining.
    SIGNALS AND CONDITIONS:

            Actual Spend Significantly Below Target
              - If \`actual_contract_spend\` < 70% of \`contract_target_price\` or \`planned_cost\`, and the project is nearing or past completion
              - This implies budget underutilization, prompting finance teams to reclaim excess funds
              2.  Contract Ceiling Price Far Above Target
              - If \`contract_ceiling_price\` > 120% of \`contract_target_price\` and actual spend remains far below target
              - This unused buffer may be viewed as excess capacity and removed in audits or future funding rounds

           .  Increased Hours Without Budget Growth
              - If \`actual_hours\` > \`allocated_hours\` but cost has not increased accordingly
              - This suggests budget has been frozen despite the rising effort, implying constrained funding

            Role or Resource Downscaling
              - If high-cost roles (e.g., architects, leads) are removed while lower-cost roles remain
              - This indicates deliberate trimming of costs — an early sign of a budget cut scenario

            Early Project Closure
              - If \`update_date\` occurs well before \`contract_end_date\` without any escalation or milestone failure
              - Indicates early shutdown or reduced engagement due to strategic reallocation of funds

             EXAMPLE RULE LOGIC:

            if (
               actual_contract_spend < contract_target_price * 0.7
               and contract_ceiling_price > contract_target_price * 1.2
               and contract nearing end
            ):
               predicted_risk = "Budget Cut"
            )

    -- Escalation Pending (
                   DEFINITION:
                   “Escalation Pending” refers to a situation where unresolved issues, delays, or misalignments have accumulated to the point that formal escalation to senior stakeholders or governance boards is imminent — but not yet triggered.
                   SIGNALS AND CONDITIONS:

                     Missed Contractual Milestones or Overdue Updates
                       - If the \`milestone_status\` is not marked “Completed” while the \`update_date\` is significantly past the \`contract_end_date\`
                       - Suggests that deliverables are overdue without resolution or communication
                       - Escalation becomes likely when delays are not managed through normal channels

                     Budget or Time Variance Without Recovery Plan
                       - High \`actual_contract_spend\` or \`actual_hours\` with no corresponding extension or documented change
                       - Indicates hidden issues being carried forward without formal stakeholder awareness

                     Resource Overutilization Across Roles
                       - If multiple roles or individuals exceed \`allocated_hours\` across reporting cycles
                       - Overuse of resources without compensation, recovery, or plan change hints at unsustainable pressure likely to trigger management intervention

                     Project Manager or Vendor Inaction
                       - If the same issues persist over multiple updates with no status change, and no change in \`project_manager\` or \`vendor\` metrics
                       - This can imply that issues are being suppressed or not effectively communicated — classic precursor to formal escalation

                     No Resolution But High Spend
                       - If the \`actual_contract_spend\` is high (e.g. >85–90% of target) while major milestones are still incomplete
                       - Indicates financial burn without progress, often leading to stakeholder alarm and escalated reviews



                   EXAMPLE RULE LOGIC:

                 if (
                       milestone_status != "Completed"
                       and update_date > contract_end_date
                       and actual_contract_spend >= contract_target_price * 0.85
                   ):
                       predicted_risk = "Escalation Pending"

                   )

    --  REQUIREMENT GAP
             DEFINITION:
                   A “Requirement Gap” occurs when there is a misalignment between the documented requirements and what is being developed, tested, or delivered. It reflects missing, misunderstood, or evolving business needs that were not captured or translated correctly into the execution phase.

                   ---

                     SIGNALS AND CONDITIONS:

                       High Actual Hours or Cost, Yet Milestone Shows Completion
                         - If \`actual_hours\` or \`actual_cost_dollars\` are significantly above planned, but the milestone is marked as "Completed"
                         - Suggests **rework or patching**, possibly due to requirements not being clearly defined from the start

                       QA Role With High Overrun
                         - If a \`QA Engineer\` or \`Tester\` shows \`actual_hours\` far above \`allocated_hours\`
                         - Implies excessive defect handling, incomplete requirements, or test cases covering functionality that wasn’t scoped

                       Development Spikes Without Corresponding Scope Change
                         - Increased hours or spend for engineering roles without a formal change in scope
                         - Indicates possible retrofitting or undocumented features surfacing late

                      	Vendor Delays Without Cost Justification
                        	- When vendors take longer but costs remain stable, it may reflect **non-functional gaps** or dependencies that weren’t originally planned for

                      	Target vs. Actual Cost Misalignment
                      	  - Large gaps between \`planned_cost\` and \`actual_cost\`, especially in design, QA, or delivery phases
                      	  - Suggests reactive effort to meet newly discovered or evolving requirements

                	  ---

            	  EXAMPLE RULE LOGIC:

            	  if (
            	  	actual_hours > allocated_hours * 1.3
            	  	and milestone_status == "Completed"
            	  	and actual_cost > planned_cost * 1.25
          	  ):
            	  	predicted_risk = "Requirement Gap"

      	  ---


3)  ###**Forecasted Cost**###-
            	  You are a financial forecasting assistant for project portfolios.

            	  Given the project details below, estimate:
            	  1. The **forecasted final cost** of the project (in USD)
            	  2. The **forecasted cost deviation** from planned cost (positive if over, negative if under)

            	  Use the following reasoning:

            	  - Calculate the hourly cost rate from actual cost and actual hours.
            	  - If actual hours exceed allocated hours by more than 10%, apply a 5–10% buffer to the actual cost.
            	  - If milestone is “Completed” but hours are significantly over, assume minor trailing effort is still possible.
            	  - Forecast the cost range accordingly.
          	  - Then, compute forecasted deviation = forecasted cost – planned cost.

          	  Return both forecasted cost and forecasted deviation as dollar values
      	  Return output in this format:
    	  {
    	  "Forecasted Final Cost(USD)":"$xxx,xxx"
    	  "Forecasted Cost Deviation(USD)":"$±xx,xxx"
    	  }


4 ####**Burnout Risk**####
    	  You are a project resource well-being assessor.

  	  Given the project and resource data below, estimate the **burnout risk percentage** for the assigned team member. Burnout risk reflects the probability (0–100%) that the resource is experiencing or will experience work-related fatigue, stress, or exhaustion.

  	  Use the following reasoning logic:

  	  1. Calculate percent overrun in actual hours vs. allocated hours.
  	  	 - <10% → Low Risk (0–30%)
  	  	 - 10–20% → Medium Risk (30–60%)
  	  	 - >20% → High Risk (60–90%)
  	  2. If the milestone is marked "Completed" and overrun exists, weight the risk higher (actual burnout likely occurred).
  	  3. Consider role context:
  	  	 - Roles like QA, Dev, or PMs under pressure may face more intense delivery cycles.
  	  4. Output only a numeric value as the burnout risk percentage (e.g., "70%").

`;

const exponentialBackoffSleep = (attempt, baseDelay = retryBaseDelay) => {
  const delay = baseDelay * (2 ** attempt);
  const jitter = Math.random() * 0.5;
  const totalDelay = (delay + jitter) * 1000;
  logger.info(`Retrying in ${totalDelay.toFixed(2)} ms...`);
  return new Promise(resolve => setTimeout(resolve, totalDelay));
};

const testMongodbConnection = async () => {
  try {
    await mongoClient.db("admin").command({ ping: 1 });
    logger.info("MongoDB connection test successful.");
    return true;
  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    return false;
  }
};

const getAiPredictionsWithRetry = async (inputData) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      logger.info(`Making Groq API call (attempt ${attempt + 1})`);

      const completion = await groqClient.chat.completions.create({
        model: LLAMA_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: pm_ai_prompt },
          { role: "user", content: JSON.stringify(inputData, null, 2) },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });

      const responseContent = completion.choices[0].message.content;
      logger.info(`Groq response: ${responseContent}`);

      const parsedJson = JSON.parse(responseContent);

      if ('Burnout' in parsedJson && !('Burnout_Risk' in parsedJson)) {
        parsedJson.Burnout_Risk = parsedJson.Burnout;
        delete parsedJson.Burnout;
      }

      if (typeof parsedJson.Forecasted_Cost === 'string') {
        parsedJson.Forecasted_Cost = parseFloat(parsedJson.Forecasted_Cost.replace(/[$,]/g, ''));
      }
      if (typeof parsedJson.Forecasted_Deviation === 'string') {
        parsedJson.Forecasted_Deviation = parseFloat(parsedJson.Forecasted_Deviation.replace(/[$,±]/g, ''));
      }
      if (typeof parsedJson.Burnout_Risk === 'string') {
        parsedJson.Burnout_Risk = parseFloat(parsedJson.Burnout_Risk.replace(/%/g, ''));
      }

      const validatedPredictions = AiPredictionSchema.parse(parsedJson);
      logger.info(`AI predictions validated successfully: ${JSON.stringify(validatedPredictions)}`);

      return validatedPredictions;
    } catch (error) {
      logger.warn(`Groq API attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < maxRetries - 1) {
        await exponentialBackoffSleep(attempt);
      } else {
        throw new Error(`All Groq API attempts failed. Last error: ${error.message}`);
      }
    }
  }
  return null;
};

const storeDocumentWithRetry = async (document, upsertKey) => {
  const collection = db.collection(PROCESSED_DATA_COLLECTION);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      logger.info(`Attempting to store document (attempt ${attempt + 1})`);
      logger.info(`Upsert key: ${JSON.stringify(upsertKey)}`);
      logger.info(`Document to store: ${JSON.stringify(document, null, 2)}`);

      const result = await collection.updateOne(
        upsertKey,
        { $set: document },
        { upsert: true }
      );

      logger.info(`MongoDB operation result: ${JSON.stringify(result)}`);

      if (result.acknowledged) {
        logger.info(`Document ${result.upsertedId ? 'inserted' : 'updated'} successfully`);
        return true;
      } else {
        throw new Error("MongoDB operation not acknowledged");
      }
    } catch (error) {
      logger.warn(`MongoDB op attempt ${attempt + 1} failed: ${error.message}`);
      logger.error(`Error details: ${error.stack}`);

      if (attempt < maxRetries - 1) {
        await exponentialBackoffSleep(attempt);
      } else {
        throw new Error(`All MongoDB operation attempts failed. Last error: ${error.message}`);
      }
    }
  }
  return false;
};

const processSingleRecord = async (record) => {
  try {
    logger.info(`Processing record: ${record.messageId}`);
    logger.info(`Record body: ${record.body}`);

    const sqsPayload = SqsPayloadSchema.parse(JSON.parse(record.body));
    const { userId,spreadsheet_id, row_index, project_identifier, sync_timestamp, input_data } = sqsPayload;

    logger.info(`Processing: ${project_identifier} (Row ${row_index}) for user ${userId}`);
    logger.info(`Input data: ${JSON.stringify(input_data, null, 2)}`);

    const aiPredictions = await getAiPredictionsWithRetry(input_data);
    if (!aiPredictions) throw new Error("Received null predictions from AI service.");

    const documentToStore = {
      userId:new onrejectionhandled(userId),
      spreadsheet_id,
      row_index,
      project_identifier,
      sync_timestamp,
      source_data: input_data,
      ai_predictions: aiPredictions,
      last_processed_at: new Date().toISOString(),
    };

    const validatedDocument = MongoDbSchema.parse(documentToStore);
    logger.info(`Document validated successfully`);

    const upsertKey = { spreadsheet_id, row_index,userId :new onrejectionhandled(userId)};
    const success = await storeDocumentWithRetry(validatedDocument, upsertKey);

    if (!success) throw new Error("Failed to store document in MongoDB after retries");

    logger.info(`Successfully processed record ${record.messageId}`);
    return { success: true, record_id: record.messageId };
  } catch (error) {
    logger.error(`Failed to process record ${record.messageId}: ${error.message}`);
    logger.error(`Error stack: ${error.stack}`);
    return { success: false, error: error.message, record_id: record.messageId };
  }
};

export const handler = async (event) => {
  logger.info(`Lambda function started. Processing ${event.Records.length} records`);

  try {
    await initializeMongoDB();

    const isConnected = await testMongodbConnection();
    if (!isConnected) {
      logger.error("MongoDB connection failed - cannot process records");
      return { batchItemFailures: event.Records.map(r => ({ itemIdentifier: r.messageId })) };
    }

    const processingPromises = event.Records.map(processSingleRecord);
    const results = await Promise.all(processingPromises);

    const batchItemFailures = results
      .filter(result => !result.success)
      .map(result => ({ itemIdentifier: result.record_id }));

    logger.info(`Processing complete. Success: ${event.Records.length - batchItemFailures.length}, Failed: ${batchItemFailures.length}`);

    return { batchItemFailures };
  } catch (error) {
    logger.error(`Handler error: ${error.message}`);
    logger.error(`Error stack: ${error.stack}`);
    return { batchItemFailures: event.Records.map(r => ({ itemIdentifier: r.messageId })) };
  }
};