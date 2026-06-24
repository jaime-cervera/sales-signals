# Legal Disclaimer & Acceptable Use

## 1. Nature of the Project

`Sales-Signals` is a collection of Markdown prompts, Node.js scripts, and a Go TUI. It is strictly a local execution tool. The maintainers do not host, deploy, or operate an AI system, nor do we provide API access to Large Language Models (LLMs).

Users download the code, run it on their own machines, and connect it to their own AI provider (Anthropic, OpenAI, or any other) and their own Unipile account. The maintainers have no visibility into, control over, or responsibility for how the tool is used after download.

## 2. Data Privacy (GDPR)

The maintainers do not act as a Data Controller or Data Processor under GDPR or any other data protection regulation.

- All personal data you input or extract — ICP definitions, prospect data, and **decision-maker contact details (name, title, LinkedIn profile)** — is processed and stored locally on your machine.
- When you use an AI CLI tool (Claude Code, Codex, OpenCode), your data is sent directly to the AI provider you chose. Review their privacy policies.
- **You are the Data Controller for any contact PII you extract via Unipile.** You are responsible for establishing a lawful basis (e.g. legitimate interest) and an appropriate retention policy. Store only what you need; a purge capability (`purge-contacts`) is provided to delete a contact or account from your CRM, derived index, and reports.
- We do not collect analytics, telemetry, or usage data of any kind.
- API keys, credentials, and per-ICP data are gitignored by default. Never commit them to a public fork.

## 3. AI Model Behavior

This tool interfaces with AI models via third-party CLI tools. The maintainers do not control these models and cannot guarantee their behavior.

- **Hallucinations:** AI models may fabricate company facts, signals, contacts, or scores. You must manually verify all generated content before acting on it.
- **Safety guardrails:** The default prompts instruct the AI never to auto-send outreach and to stop before the final send action. However, AI compliance is not guaranteed. If you use different models, modify the system prompts, or override the safety instructions, you accept full responsibility for the AI's actions.
- **Scoring accuracy:** Account-fit scores and recommendations are AI-generated opinions based on pattern matching, not professional sales or legal advice. They should inform your judgment, not replace it.

## 4. Third-Party Platforms

Sales-Signals interacts with ATS feeds and job boards (Greenhouse, Lever, Ashby, Workday, and others) and with LinkedIn via the **Unipile** API.

- Users must comply with the Terms of Service of every platform they interact with, including LinkedIn and Unipile.
- Use only the sanctioned Unipile API on your own connected account. Do not use this tool to scrape platforms that prohibit automated access.
- Do not use this tool to spam companies, overwhelm systems, or send mass outreach.
- **Residual account risk:** LinkedIn may restrict or suspend a connected account for automated querying even via a sanctioned API. Keep query volume modest and honor rate limits.
- Any consequences from ToS violations — including IP bans, account restrictions, or legal action from platforms — are solely the responsibility of the user.

## 5. Acceptable Use

Sales-Signals is designed to help vendors find and prioritize genuinely-fitting prospect accounts, not to automate away human judgment. Acceptable use includes:

- Discovering and scoring companies showing a genuine buying signal
- Qualifying accounts against your ICP before reaching out
- Drafting outreach that you review and edit before sending
- Tracking your prospect pipeline

Unacceptable use includes:

- Auto-sending outreach without human review
- Scraping platforms that prohibit automated access
- Mass, untargeted outreach
- Using extracted contact PII unlawfully or beyond your stated lawful basis

## 6. EU AI Act

Because this tool runs locally, is free, and is open-source, the maintainers are not placing an AI system on the market or putting one into service under the EU AI Act. Users who deploy the tool in a commercial or organizational context should assess their own obligations under the AI Act.

## 7. Indemnification

By using Sales-Signals, you agree to indemnify, defend, and hold harmless the authors, contributors, and any affiliated parties from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising from your use of this software, your violation of these terms, or your violation of any third-party terms of service.

## 8. Cost Responsibility

If you use paid AI providers or paid Unipile tiers, you are solely responsible for monitoring and managing your own usage and associated costs. The maintainers are not responsible for unexpected charges.

## 9. MIT License

As stated in the [LICENSE](LICENSE) file:

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 10. Changes

This disclaimer may be updated as the project evolves. Users are encouraged to review it periodically.
