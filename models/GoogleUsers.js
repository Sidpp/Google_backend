const mongoose = require("mongoose");
const userSchema = new mongoose.Schema(
{
name: { type: String, required: true },
email: { type: String, required: true, unique: true },
password: { type: String, required: true },
role: { type: String, enum: ["Admin", "User"], required: true },
jira_credential_id: {
type: mongoose.Schema.Types.ObjectId,
ref: "JiraCredential",
},

google_credential_id: {
type: mongoose.Schema.Types.ObjectId,
ref: "GoogleCredential", 
},

},
{ timestamps: true } 
);
module.exports = mongoose.model("User", userSchema);