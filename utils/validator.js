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

const bulkImportSchema = z.object({
  data: z.array(z.object({
    project_identifier: z.string(),
    sync_timestamp: z.string().datetime(),
    input_data: inputDataSchema
  }))
});

const updateSchema = z.object({
  project_identifier: z.string(),
  sync_timestamp: z.string().datetime(),
  input_data: inputDataSchema
});

module.exports = {
  bulkImportSchema,
  updateSchema
};
