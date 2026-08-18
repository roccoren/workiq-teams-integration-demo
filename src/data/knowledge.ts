// Sample "internal information" knowledge base for the demo's mock engine.
// Mirrors the shapes Work IQ returns for a real tenant (emails, documents,
// meetings, chats, people) so the demo behaves identically in both modes.
// All names, emails, and content are fictional Contoso data.

export interface Person {
  id: string;
  name: string;
  title: string;
  team: string;
  manager: string;
  email: string;
  location: string;
  bio: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  kind: "policy" | "playbook" | "status" | "okr" | "guide" | "review";
  owner: string;
  updated: string;
  teamsUrl: string;
  content: string[];
  keywords: string[];
}

export interface EmailThread {
  id: string;
  from: string;
  subject: string;
  date: string;
  to: string[];
  cc?: string[];
  summary: string;
  body: string;
  url: string;
}

export interface Meeting {
  id: string;
  title: string;
  when: string;
  time: string;
  organizer: string;
  attendees: string[];
  recurring?: string;
  agenda: string[];
  teamsUrl: string;
}

export interface ChannelMessage {
  id: string;
  channel: string;
  author: string;
  date: string;
  text: string;
  url: string;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  messages: ChannelMessage[];
}

export const PEOPLE: Person[] = [
  { id: "p1", name: "James O'Brien", title: "Chief Technology Officer", team: "Executive", manager: "—", email: "james.obrien@contoso.com", location: "Redmond, WA", bio: "CTO since 2021. Sponsors the AI platform strategy and Project Atlas." },
  { id: "p2", name: "Alex Morgan", title: "VP Engineering, AI Platform", team: "Engineering", manager: "James O'Brien", email: "alex.morgan@contoso.com", location: "Redmond, WA", bio: "Owns Project Atlas end-to-end: roadmap, staffing, and delivery. Previously led the Copilot infrastructure team." },
  { id: "p3", name: "Sarah Chen", title: "Director of Product, AI Platform", team: "Product", manager: "Alex Morgan", email: "sarah.chen@contoso.com", location: "Seattle, WA", bio: "Runs product management for Atlas. Owns the Q3 budget reallocation for the program." },
  { id: "p4", name: "David Kim", title: "Engineering Manager, Atlas", team: "Engineering", manager: "Alex Morgan", email: "david.kim@contoso.com", location: "Vancouver, BC", bio: "Manages the Atlas engineering squad (12 engineers). Drives sprints and delivery." },
  { id: "p5", name: "Priya Sharma", title: "Head of Finance", team: "Finance", manager: "James O'Brien", email: "priya.sharma@contoso.com", location: "Redmond, WA", bio: "Owns budgeting, expense policy, and procurement approvals for the company." },
  { id: "p6", name: "Emily Rodriguez", title: "HR Manager", team: "People", manager: "James O'Brien", email: "emily.rodriguez@contoso.com", location: "Austin, TX", bio: "Owns policies: PTO, leave, onboarding. Runs the quarterly people survey." },
  { id: "p7", name: "Linda Zhou", title: "Marketing Director", team: "Marketing", manager: "James O'Brien", email: "linda.zhou@contoso.com", location: "New York, NY", bio: "Runs field marketing and the Q3 product launch campaign." },
  { id: "p8", name: "Tom Becker", title: "IT Security Lead", team: "IT", manager: "James O'Brien", email: "tom.becker@contoso.com", location: "Dublin, IE", bio: "Owns information security policy, access reviews, and security training." },
];

export const DOCUMENTS: KnowledgeDoc[] = [
  {
    id: "d1",
    title: "Project Atlas — Q3 Status Update",
    kind: "status",
    owner: "Alex Morgan",
    updated: "2025-07-28",
    teamsUrl: "https://contoso.sharepoint.com/sites/AI-Platform/Shared%20Documents/Project%20Atlas%20%E2%80%94%20Q3%20Status%20Update.pptx",
    keywords: ["atlas", "project atlas", "status", "update", "milestone", "roadmap", "private preview", "ga", "schedule", "on track"],
    content: [
      "**Overall status: ON TRACK.** Project Atlas — the governed action layer for AI agents — remains on schedule for private preview in Q1 FY26 and general availability in Q4 FY26.",
      "**Milestones completed (Q3):** tool discovery service GA'd to internal consumers; execution runtime v0.9 passed security review; tenant policy framework v1 shipped to 3 pilot teams.",
      "**In flight:** agent governance dashboard (target: mid-August); MCP gateway hardening; compliance reporting for the finance pilot.",
      "**Risks:** two open security findings (P2) from the July pen test — being remediated by Tom Becker's team; resourcing gap of 2 engineers on the governance workstream.",
      "**Ownership:** Alex Morgan (VP Engineering) is the executive owner; Sarah Chen owns product and budget; David Kim leads the engineering squad.",
      "**Budget:** Q3 allocation $1.2M approved (Sarah Chen), spend to date $780K (65%), reforecast submitted in July.",
    ],
  },
  {
    id: "d2",
    title: "FY26 Q3 Company OKRs",
    kind: "okr",
    owner: "James O'Brien",
    updated: "2025-06-30",
    teamsUrl: "https://contoso.sharepoint.com/sites/contoso/Shared%20Documents/FY26%20Q3%20Company%20OKRs.docx",
    keywords: ["okr", "okrs", "objective", "key result", "q3", "goals", "metrics"],
    content: [
      "**O1 — Ship the AI platform.** KR1: 5 external customers in private preview by end of Q3. KR2: p99 latency of the execution runtime under 800 ms. KR3: 100% of tenants on the policy framework.",
      "**O2 — Grow enterprise revenue.** KR1: 12 new enterprise logos. KR2: $4.2M net-new ARR. KR3: 90% CSAT on onboarding.",
      "**O3 — Be a great place to work.** KR1: engagement score ≥ 78. KR2: attrition < 8%. KR3: 100% of managers complete people-leader training.",
    ],
  },
  {
    id: "d3",
    title: "Expense Reimbursement Policy v4.2",
    kind: "policy",
    owner: "Priya Sharma",
    updated: "2025-05-12",
    teamsUrl: "https://contoso.sharepoint.com/sites/contoso/Shared%20Documents/Expense%20Reimbursement%20Policy%20v4.2.pdf",
    keywords: ["expense", "reimbursement", "reimburse", "receipt", "travel", "spend", "claim", "finance", "money"],
    content: [
      "Expense reports must be submitted **within 30 days** of the expense date via the Workday portal.",
      "Receipts are required for all expenses **over $25**. Digital scans are accepted.",
      "Reimbursements are paid on the **next bi-weekly payroll cycle** after approval.",
      "The finance approval threshold is $1,000; anything above requires Director-level approval.",
      "Alcohol, personal items, and upgrades are not reimbursable. Team meals are capped at $75/person.",
      "Expense fraud or repeated violations are treated as a conduct issue per HR policy.",
    ],
  },
  {
    id: "d4",
    title: "PTO & Leave Policy (2025)",
    kind: "policy",
    owner: "Emily Rodriguez",
    updated: "2025-03-01",
    teamsUrl: "https://contoso.sharepoint.com/sites/contoso/Shared%20Documents/PTO%20and%20Leave%20Policy%202025.pdf",
    keywords: ["pto", "vacation", "leave", "time off", "holiday", "sick", "days", "unlimited"],
    content: [
      "Contoso offers **unlimited PTO** for exempt employees, subject to manager approval and a minimum of 15 days taken per year.",
      "Non-exempt employees accrue **15 days** of PTO per year, prorated monthly.",
      "PTO requests should be submitted **at least 2 weeks** in advance; requests during a freeze period (last 2 weeks of each quarter) need VP approval.",
      "Sick leave: 10 days per year, no doctor's note required under 3 consecutive days.",
      "Parental leave: 16 weeks fully paid, plus 4 weeks phased return.",
    ],
  },
  {
    id: "d5",
    title: "Enterprise Sales Playbook 2025",
    kind: "playbook",
    owner: "Sarah Chen",
    updated: "2025-06-15",
    teamsUrl: "https://contoso.sharepoint.com/sites/sales/Shared%20Documents/Enterprise%20Sales%20Playbook%202025.pptx",
    keywords: ["sales", "playbook", "deal", "pipeline", "enterprise", "pricing", "discount", "quota", "customer"],
    content: [
      "Enterprise deals follow a **MEDDICC** qualification: Metrics, Economic buyer, Decision criteria, Decision process, Identify pain, Champion, Competition.",
      "Standard discounting authority: sales reps up to **10%**, directors up to **20%**, anything above requires the CRO.",
      "The executive sponsor meeting must happen before any deal > $250K enters stage 4.",
      "Customer references must be secured for all platform deals before contracting.",
      "Renewal risk reviews happen monthly; churn mitigation plans need Finance sign-off.",
    ],
  },
  {
    id: "d6",
    title: "Information Security Policy v7",
    kind: "policy",
    owner: "Tom Becker",
    updated: "2025-07-01",
    teamsUrl: "https://contoso.sharepoint.com/sites/IT/Shared%20Documents/Information%20Security%20Policy%20v7.pdf",
    keywords: ["security", "policy", "password", "mfa", "access", "data", "classification", "incident", "phishing"],
    content: [
      "All accounts require **MFA**; exceptions require quarterly review by IT Security.",
      "Data is classified as Public, Internal, Confidential, or Restricted. Confidential+ data must be encrypted at rest and in transit.",
      "Access reviews run **quarterly**; dormant accounts (90+ days) are disabled automatically.",
      "Security incidents must be reported within **1 hour** via the #security-incidents channel or the IT hotline.",
      "External sharing of Internal+ data requires DLP approval and expiration dates.",
      "Annual security training is mandatory; completion below 95% blocks quarterly access reviews sign-off.",
    ],
  },
  {
    id: "d7",
    title: "New Hire Onboarding Guide",
    kind: "guide",
    owner: "Emily Rodriguez",
    updated: "2025-02-20",
    teamsUrl: "https://contoso.sharepoint.com/sites/people/Shared%20Documents/New%20Hire%20Onboarding%20Guide.docx",
    keywords: ["onboarding", "new hire", "first day", "laptop", "orientation", "welcome", "buddy"],
    content: [
      "Day 1: laptop pickup (IT), badge, and a welcome session at 10:00 AM local time.",
      "Day 1–3: complete security training, set up MFA, and join the #general and team channels.",
      "Week 1: onboarding buddy assigned; manager 1:1 daily; 30/60/90 plan created.",
      "Week 2: shadow a customer call; complete product immersion training.",
      "Week 4: onboarding survey; 30-day check-in with HR.",
    ],
  },
  {
    id: "d8",
    title: "IT Hardware Procurement Guide",
    kind: "guide",
    owner: "Tom Becker",
    updated: "2025-04-10",
    teamsUrl: "https://contoso.sharepoint.com/sites/IT/Shared%20Documents/IT%20Hardware%20Procurement%20Guide.pdf",
    keywords: ["hardware", "procurement", "laptop", "monitor", "order", "it", "equipment", "device"],
    content: [
      "Standard laptop: **Dell Latitude 7450** (or MacBook Pro 14 for design/eng roles with approval).",
      "Orders go through the IT procurement portal; standard delivery is **5 business days**.",
      "Monitors (up to 2), docking stations, and headsets are ordered via the same portal with manager approval.",
      "Special requests (> $2,000) require Finance sign-off and are reviewed monthly.",
    ],
  },
  {
    id: "d9",
    title: "Customer Success Quarterly Review — Q2 FY26",
    kind: "review",
    owner: "Sarah Chen",
    updated: "2025-07-15",
    teamsUrl: "https://contoso.sharepoint.com/sites/CS/Shared%20Documents/Customer%20Success%20Quarterly%20Review%20Q2%20FY26.pptx",
    keywords: ["customer success", "csat", "nps", "churn", "review", "quarterly", "renewal", "satisfaction"],
    content: [
      "Q2 CSAT: **88%** (target 85%). NPS: **+42** (up 6 points QoQ).",
      "Renewal rate: 94% on $3.1M in renewals; 2 logos churned (both under $50K).",
      "Onboarding time to first value: 21 days (target 30).",
      "Top churn drivers: pricing (38%), product gaps (31%), onboarding friction (19%).",
      "Action plan for Q3: enterprise onboarding sprints, pricing pack review, and a CS playbook refresh.",
    ],
  },
  {
    id: "d10",
    title: "Project Atlas — Architecture & Roadmap Deck",
    kind: "status",
    owner: "Alex Morgan",
    updated: "2025-07-20",
    teamsUrl: "https://contoso.sharepoint.com/sites/AI-Platform/Shared%20Documents/Project%20Atlas%20Architecture%20and%20Roadmap.pptx",
    keywords: ["atlas", "architecture", "roadmap", "governance", "agents", "execution runtime", "discovery", "policy"],
    content: [
      "Atlas is the **governed action layer for AI agents**: agent tool discovery, policy enforcement, and execution.",
      "Architecture: discovery service → policy engine → execution runtime → audit & compliance store.",
      "Roadmap: private preview Q1 FY26 (3 pilot customers), GA Q4 FY26, enterprise governance suite FY27 H1.",
      "Differentiators: per-agent policy inheritance, real-time execution auditing, and federated tool catalog.",
    ],
  },
];

export const EMAILS: EmailThread[] = [
  {
    id: "e1",
    from: "Sarah Chen",
    subject: "Q3 budget reallocation for Project Atlas",
    date: "2025-07-22",
    to: ["Alex Morgan", "Priya Sharma"],
    cc: ["David Kim"],
    summary: "Approves $1.2M Q3 allocation for Atlas; $200K moved from marketing to fund the governance workstream; reforecast due by end of July.",
    body: "Hi Alex — following up on the reforecast: we approved the $1.2M Q3 allocation for Project Atlas. I moved $200K from the marketing budget (Linda is aware) to fully fund the governance workstream. Spend to date is $780K (65%). Please make sure David's team submits the reforecast in Workday by end of July. Best, Sarah",
    url: "https://outlook.office.com/mail/AAMkADAtlasQ3Budget001",
  },
  {
    id: "e2",
    from: "David Kim",
    subject: "Atlas sprint 14 — status and risks",
    date: "2025-07-24",
    to: ["Alex Morgan", "Sarah Chen"],
    summary: "Sprint 14 done: policy engine v1 shipped to 3 pilot teams; 2 open P2 security findings; 2-engineer resourcing gap on governance.",
    body: "Team — sprint 14 is complete. Shipped: policy engine v1 (3 pilot teams), discovery API GA to internal consumers. Open: two P2 security findings from the July pen test, Tom's team is on it. Risk: we're 2 engineers short on the governance workstream — this could push the mid-August dashboard target. Please advise on backfill. — David",
    url: "https://outlook.office.com/mail/AAMkADAtlasSprint14",
  },
  {
    id: "e3",
    from: "Priya Sharma",
    subject: "Reminder: expense reports due before quarter close",
    date: "2025-07-18",
    to: ["All Staff"],
    summary: "All Q2 expenses must be submitted by Aug 1; receipts over $25 required; reimbursement lands on the next payroll cycle.",
    body: "Hi all — a reminder that all outstanding Q2 expenses must be submitted in Workday by **August 1** so they land in the next bi-weekly payroll cycle. Receipts are required for anything over $25. Late submissions will be processed in September. Thanks, Priya",
    url: "https://outlook.office.com/mail/AAMkADExpenseReminderQ3",
  },
  {
    id: "e4",
    from: "Emily Rodriguez",
    subject: "PTO policy refresh — what changed",
    date: "2025-07-10",
    to: ["All Staff"],
    summary: "Unlimited PTO clarified for exempt staff (min 15 days); 2-week advance notice; quarter-end freeze needs VP approval.",
    body: "We refreshed the PTO policy. Key changes: exempt employees keep unlimited PTO but are expected to take at least 15 days/year; requests need 2 weeks' notice; the last 2 weeks of each quarter are a freeze period unless VP-approved. Full details in the policy doc. — Emily",
    url: "https://outlook.office.com/mail/AAMkADPTOPolicyRefresh",
  },
  {
    id: "e5",
    from: "Tom Becker",
    subject: "Security training completion — annual requirement",
    date: "2025-07-08",
    to: ["All Staff"],
    summary: "Annual security training must be completed by Aug 15; completion below 95% blocks access review sign-off.",
    body: "Annual security training opens today and is due **August 15**. It takes ~45 minutes. Teams below 95% completion will block quarterly access review sign-off. Incident reporting: #security-incidents within 1 hour. — Tom",
    url: "https://outlook.office.com/mail/AAMkADSecurityTraining2025",
  },
  {
    id: "e6",
    from: "Linda Zhou",
    subject: "Q3 launch campaign kickoff — Atlas story",
    date: "2025-07-25",
    to: ["Sarah Chen", "Alex Morgan"],
    summary: "Marketing plans the Q3 launch around Atlas; needs 1-pager, customer quotes, and a demo by Aug 10.",
    body: "Sarah, Alex — we're kicking off the Q3 campaign around Project Atlas ('Your agents, governed'). We need from you by Aug 10: a 1-pager on Atlas, 2 customer quotes (privacy-respecting), and a 3-minute demo video. Linda",
    url: "https://outlook.office.com/mail/AAMkADQ3LaunchKickoff",
  },
];

export const MEETINGS: Meeting[] = [
  {
    id: "m1",
    title: "Project Atlas weekly sync",
    when: "Today",
    time: "10:00 – 10:45 AM",
    organizer: "David Kim",
    attendees: ["Alex Morgan", "Sarah Chen", "David Kim", "8 Atlas engineers"],
    recurring: "Weekly",
    agenda: ["Sprint review", "Governance dashboard milestone", "Security findings status", "Resourcing"],
    teamsUrl: "https://teams.microsoft.com/l/meeting/join?meetingId=atlas-weekly-0714",
  },
  {
    id: "m2",
    title: "Q3 OKR review",
    when: "Tomorrow",
    time: "2:00 – 3:00 PM",
    organizer: "James O'Brien",
    attendees: ["James O'Brien", "Alex Morgan", "Sarah Chen", "Priya Sharma", "Emily Rodriguez", "Linda Zhou"],
    agenda: ["O1 AI platform progress", "O2 revenue pipeline", "O3 people metrics", "Q4 planning intake"],
    teamsUrl: "https://teams.microsoft.com/l/meeting/join?meetingId=q3-okr-review",
  },
  {
    id: "m3",
    title: "Budget planning — FY26 Q4",
    when: "Friday",
    time: "9:30 – 11:00 AM",
    organizer: "Priya Sharma",
    attendees: ["Priya Sharma", "Sarah Chen", "All directors"],
    agenda: ["Q3 actuals review", "Atlas Q4 request", "Headcount plan", "Approvals"],
    teamsUrl: "https://teams.microsoft.com/l/meeting/join?meetingId=fy26-q4-budget",
  },
  {
    id: "m4",
    title: "1:1 — Alex Morgan",
    when: "Monday",
    time: "9:00 – 9:30 AM",
    organizer: "James O'Brien",
    attendees: ["James O'Brien", "Alex Morgan"],
    agenda: ["Atlas status", "Career growth", "Cross-team collaboration"],
    teamsUrl: "https://teams.microsoft.com/l/meeting/join?meetingId=o1-1-alex",
  },
  {
    id: "m5",
    title: "Company All-Hands",
    when: "Thursday",
    time: "4:00 – 5:00 PM",
    organizer: "James O'Brien",
    attendees: ["All staff"],
    agenda: ["Q3 highlights", "Atlas private preview announcement", "Customer win stories", "Q&A"],
    teamsUrl: "https://teams.microsoft.com/l/meeting/join?meetingId=all-hands-q3",
  },
];

export const CHANNELS: Channel[] = [
  {
    id: "c1",
    name: "general",
    topic: "Company-wide announcements",
    messages: [
      { id: "c1m1", channel: "general", author: "Emily Rodriguez", date: "2025-07-25", text: "All-hands Thursday 4 PM — James will announce the Project Atlas private preview and Q3 highlights. Add it to your calendar!", url: "https://teams.microsoft.com/l/message/19:general/1" },
      { id: "c1m2", channel: "general", author: "Priya Sharma", date: "2025-07-18", text: "Reminder: expense reports due Aug 1 for Q2. See email for details.", url: "https://teams.microsoft.com/l/message/19:general/2" },
    ],
  },
  {
    id: "c2",
    name: "engineering",
    topic: "Atlas and platform engineering",
    messages: [
      { id: "c2m1", channel: "engineering", author: "David Kim", date: "2025-07-26", text: "Sprint 15 planning tomorrow 9 AM. Governance dashboard is the top priority — we need to close the resourcing gap before mid-August.", url: "https://teams.microsoft.com/l/message/19:engineering/1" },
      { id: "c2m2", channel: "engineering", author: "Sarah Chen", date: "2025-07-24", text: "Product spec for the Atlas agent governance dashboard is now in the shared drive — please review by Friday.", url: "https://teams.microsoft.com/l/message/19:engineering/2" },
      { id: "c2m3", channel: "engineering", author: "Tom Becker", date: "2025-07-23", text: "Security: the July pen test report is out. Two P2 findings are assigned to the Atlas team — target remediation Aug 10.", url: "https://teams.microsoft.com/l/message/19:engineering/3" },
    ],
  },
  {
    id: "c3",
    name: "sales",
    topic: "Deals and pipeline",
    messages: [
      { id: "c3m1", channel: "sales", author: "Linda Zhou", date: "2025-07-25", text: "Q3 campaign kickoff: Atlas story needs quotes + demo by Aug 10. Sales enablement session next Tuesday.", url: "https://teams.microsoft.com/l/message/19:sales/1" },
      { id: "c3m2", channel: "sales", author: "Sarah Chen", date: "2025-07-21", text: "Reminder: deals > $250K need the executive sponsor meeting before stage 4 (sales playbook section 3).", url: "https://teams.microsoft.com/l/message/19:sales/2" },
    ],
  },
];

export interface KnowledgeBase {
  people: Person[];
  documents: KnowledgeDoc[];
  emails: EmailThread[];
  meetings: Meeting[];
  channels: Channel[];
}

export const KNOWLEDGE: KnowledgeBase = { people: PEOPLE, documents: DOCUMENTS, emails: EMAILS, meetings: MEETINGS, channels: CHANNELS };
