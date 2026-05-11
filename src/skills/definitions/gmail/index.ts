import type { SkillDefinition } from "../../types.js";

const skillDef: SkillDefinition = {
  name: "Gmail Task Automation",
  version: "1.0.0",
  init: async () => {
    // No initialization needed — tools auto-registered
  },
  manifest: {
    id: "gmail",
    name: "Gmail Task Automation",
    description: "Read Gmail, extract tasks from emails, execute them, and reply with results. Strict guardrails for who can email.",
    category: "communicate",
    tools: ["gmail-read", "gmail-reply"],
    configFields: [],
    version: "1.0.0",
  },
  getPromptContext: () => ({
    skillId: "gmail",
    instructions: `You can read and reply to emails via Gmail, but with strict safety guardrails.

## Available Tools
- **gmail-read**: Fetch unread emails from whitelisted senders only
  - Automatically filters out non-whitelisted senders
  - Returns from, subject, body, date for analysis

- **gmail-reply**: Reply to whitelisted senders only
  - Can only send to the person who sent the original email
  - Must be an email from a whitelisted address
  - Used to confirm task completion

## How It Works
1. Read emails from whitelisted senders using gmail-read
2. Extract task requirements from email bodies
3. Execute the tasks requested
4. Use gmail-reply to send completion status back to the sender

## Safety Guardrails
- ✅ Can only read emails from whitelisted senders
- ✅ Can only reply to those same whitelisted senders
- ✅ Cannot BCC, CC, or forward to other recipients
- ✅ Cannot send unsolicited emails
- ✅ All email activity is logged
- ✅ Whitelist managed by workspace admin via gmail_whitelist table

## Setup Required
1. Workspace admin creates a Gmail service account with Gmail API access
2. Admin adds service account JSON as GMAIL_CREDENTIALS_JSON in workspace secrets
3. Admin adds trusted email addresses to gmail_whitelist table
4. Tasks from those senders will be automatically processed

## Example Workflow
- Trusted user emails: "Please generate a report for last month"
- You read the email, understand the request
- Execute ga4-query or other tools to generate the report
- Reply with the results using gmail-reply`,
  }),
};

export default skillDef;
