const { z } = require("zod");

const stringToNumber = z.preprocess((val) => {
  if (typeof val === 'string' && val.trim() !== '') {
    
    const cleanedVal = val.replace(/[$,±%]/g, '').trim();
    if (cleanedVal === '') return null;
    
    const num = parseFloat(cleanedVal);
    return isNaN(num) ? null : num; 
  }
   return val;
}, z.number().nullable()); 

const inputDataSchema = z.object({
  Project: z.string(),
  Program: z.any().optional(),
  Portfolio: z.any().optional(),
  "Project Manager": z.any().optional(),
  Vendor: z.any().optional(),
  "Contract ID": z.any().optional(),
  "Contract Start Date": z.any().optional(),
  "Contract End Date": z.any().optional(),
  

  "Contract Ceiling Price": stringToNumber.optional(),
  "Contract Target Price": stringToNumber.optional(),
  "Actual Contract Spend": stringToNumber.optional(),
  

  "Resource Name": z.any().optional(),
  Role: z.any().optional(),
  "Allocated Hours": stringToNumber.optional(),
  "Actual Hours": stringToNumber.optional(),
  "Actual Cost": stringToNumber.optional(),
  "Planned Cost": stringToNumber.optional(),

  "Project Status (RAG)": z.any().optional(), 
  "Milestone Status": z.any().optional(),
  Issues: z.any().optional(),
  Risks: z.any().optional(),
  "Update Date": z.any().optional(),
  
  
}).passthrough(true);

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
  bulkImportRowSchema,     
  bulkImportBatchSchema,    
  updateSchema,
  inputDataSchema
};
