# AC Smart Service Dashboard — Production-Ready V2

🚀 **Live Deployment URL:** [https://ac-smart-service.virallink.workers.dev](https://ac-smart-service.virallink.workers.dev)

An intelligent, full-stack AC Servicing & Maintenance Automation Platform powered by **Cloudflare Workers**, **Cloudflare D1 Database**, **Evolution API**, and **AI (Anthropic Claude / OpenAI / Intelligent Fallback Engine)**.

---

## 🌟 Key Features

1. **WhatsApp AI Service Assistant:**
   - Automatically handles incoming customer WhatsApp messages.
   - Extracts customer name, phone number, address, and AC issue details step-by-step.
   - Creates structured service requests in Cloudflare D1.
   - Strict business rules: never hallucinates technician availability, price, or unconfirmed appointment times.

2. **Webhooks & Idempotency:**
   - Dedicated webhook endpoint: `POST /webhook/messages`
   - Validates payloads, rejects `fromMe` outgoing echoes, and deduplicates WhatsApp message IDs.

3. **Human Takeover & Admin Live Chat:**
   - Instant 1-click **Takeover (হ্যান্ডওভার)** and **Resume AI (এআই চালু)** toggles from the dashboard.
   - Admin can message customers directly through WhatsApp from the dashboard.

4. **Service Request Kanban Board:**
   - Visual Kanban pipeline: **Pending**, **Scheduled**, **In Progress**, **Completed**, **Cancelled**.
   - Assign technicians, set scheduled dates/times, and track estimated & final costs (SAR).

5. **Automated Maintenance Reminders:**
   - Customizable service reminder intervals (e.g. 90 days after service completion).
   - Automated Cloudflare Cron Trigger + manual dashboard trigger.
   - Template variables support: `{{customer_name}}`, `{{days_since}}`.

6. **Dynamic Bot Configuration:**
   - Edit System Prompt, Greetings, Address Question, Issue Question, and Handover messages directly from the dashboard without redeploying code.

---

## 🔑 Access Credentials

- **URL:** [https://ac-smart-service.virallink.workers.dev](https://ac-smart-service.virallink.workers.dev)
- **Admin Email:** `admin@accare.com`
- **Default Password:** `admin123456`

---

## 🛠️ Architecture

- **Backend & Host:** Cloudflare Workers (Edge Serverless)
- **Database:** Cloudflare D1 Relational SQLite Database (`ac-smart-service-db`)
- **Frontend Dashboard:** Integrated Single-Page Application (Tailwind CSS, Responsive, Real-time 4s Polling)
- **WhatsApp Gateway:** Evolution API (`/message/sendText`)
- **Security:** Web Crypto PBKDF2 Password Hashing, Secure Session Cookies, Full Audit Trail
