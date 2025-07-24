const { z } = require("zod");

const stringToNumber = z.preprocess((val) => {
  if (typeof val === 'string' && val.trim() !== '') {
    const num = parseFloat(val);
    return isNaN(num) ? val : num;
  }
  return val;
}, z.number());

const inputDataSchema = z.object({
  Project: z.string(),
  Program: z.any().optional(),
  Portfolio: z.any().optional(),
  "Project Manager": z.any().optional(),
  Vendor: z.any().optional(),
  "Contract ID": z.any().optional(),
  "Contract Start Date": z.any().optional(),
  "Contract End Date": z.any().optional(),
  "Contract Ceiling Price": stringToNumber.optional().nullable(),
  "Contract Target Price": stringToNumber.optional().nullable(),
  "Actual Contract Spend": stringToNumber.optional().nullable(),
  "Expiring Soon": z.any().optional(),
  "Resource Name": z.any().optional(),
  Role: z.any().optional(),
  "Allocated Hours": stringToNumber.optional().nullable(),
}).passthrough(true);

// FIXED: Schema for individual row messages (what you're actually sending)
const bulkImportRowSchema = z.object({
  connectionId: z.string(),
  userId: z.string(),
  spreadsheet_id: z.string(),
  sheet_range: z.string(),
  row_index: z.number(),
  project_identifier: z.string(),
  sync_timestamp: z.string().datetime(),
  input_data: inputDataSchema
});

// Keep this for batch operations if needed
const bulkImportBatchSchema = z.object({
  data: z.array(bulkImportRowSchema)
});

const updateSchema = z.object({
  connectionId: z.string().optional(),
  userId: z.string().optional(),
  spreadsheet_id: z.string().optional(),
  sheet_range: z.string().optional(),
  row_index: z.number().optional(),
  project_identifier: z.string(),
  sync_timestamp: z.string().datetime(),
  input_data: inputDataSchema
});

module.exports = {
  bulkImportRowSchema,      // For individual row validation
  bulkImportBatchSchema,    // For batch validation if needed
  updateSchema,
  inputDataSchema
};