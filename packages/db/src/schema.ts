// One Launchpad instance = one partner. Tenants are the partner's customers; each deployment
// is one site with its own Agentic RAG Knowledge Box and keys.

import type { Language, LanguageSetting, SitePlatform, SiteScanExtras, ThemeInput, ThemeTokens, WidgetSettings } from "@launchpad/theme";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tenantStatus = pgEnum("tenant_status", ["active", "paused", "archived"]);
export const deploymentStatus = pgEnum("deployment_status", ["draft", "provisioning", "live", "paused", "failed"]);
export const contentPath = pgEnum("content_path", ["sitefinity_connector", "sitemap", "manual"]);
// Which widget the site runs: <arag-chat> or Sitefinity's own. Its layout (embedded, chat,
// popup, floating) is widget_settings.mode, and its finish is in theme.
export const widgetMode = pgEnum("widget_mode", ["embed", "sitefinity_native"]);
export const keyRole = pgEnum("key_role", ["reader", "writer", "manager"]);
export const syncKind = pgEnum("sync_kind", ["sitefinity_connector", "sitemap", "sharepoint", "s3"]);
// A synced page: waiting, sent to the KB and being processed, answerable, or left out (and why).
export const pageStatus = pgEnum("page_status", ["queued", "processing", "indexed", "skipped", "failed", "removed"]);
export const userRole = pgEnum("user_role", ["partner_admin", "partner_member", "customer_viewer"]);
// A customer contact's access to the customer's KBs in the Agentic RAG dashboard, granted
// by invite: SMEMBER, SCONTRIBUTOR, SOWNER. Null means not invited.
export const contactKbRole = pgEnum("contact_kb_role", ["member", "contributor", "owner"]);

export const BILLING_METHODS = ["invoice", "card", "bank_transfer", "other"] as const;
export const PAYMENT_TERMS = ["due_on_receipt", "net_15", "net_30", "net_60"] as const;

// How a customer pays. Details and references only: card and bank numbers live in the
// partner's billing system, never here.
export interface BillingDetails {
  contactName?: string;
  contactEmail?: string;
  address?: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string };
  method?: (typeof BILLING_METHODS)[number];
  terms?: (typeof PAYMENT_TERMS)[number];
  poNumber?: string;
  taxId?: string;
  // The customer's id in the partner's billing system (Stripe, QuickBooks, …).
  externalRef?: string;
}

export type BudgetMode = "alert" | "stop";

// What an answer needs a person to check before sign-off: it states a price, a date or a
// deadline, or every source is an overview page (home, listing, tag, category).
// stale-source: the answer cites a page the content rules flag (an old price or offer, older than
// 2 years, a conversion page).
export type ValidationFlag = "price" | "date" | "overview-sources" | "stale-source";

export interface ValidationQuestion {
  question: string;
  answer: string;
  sources: { title: string; url: string }[];
  // The shared verdict (the widget's rule): an answer from the content.
  answered: boolean;
  // Typed by the partner, rather than generated from the site.
  own?: boolean;
  // Why it failed beyond "no answer", e.g. "Talks about how it works internally".
  failure?: string;
  flags?: ValidationFlag[];
  // Who checked the flagged answer against the site.
  acknowledged?: Confirmation;
}

export interface ValidationResult {
  at: string;
  questions: ValidationQuestion[];
  // Enough answered, the partner's own questions included, nothing failing, and every flag acknowledged.
  passed: boolean;
  // Fewer good questions could be generated than asked for.
  generationNote?: string;
}

// A person's confirmation, or an explicit choice to go without.
export interface Confirmation {
  by: string | null;
  // The signed-in person's name, or the typed name in setup mode.
  name: string;
  at: string;
  // Named sign-in, rather than a typed name in setup mode.
  verified: boolean;
}

// What a person confirmed on the way to sign-off, by part. Missing means not yet.
export interface DeploymentConfirmations {
  // The chat name, avatar and primary color as saved at the time.
  brand?: Confirmation & { values: { nickname?: string; avatar?: string; primary: string } };
  // Starter questions chosen in the picker (choosing none counts, once confirmed).
  starters?: Confirmation;
  // "No handoff: visitors who get no answer have no way to reach the team".
  noHandoff?: Confirmation;
  // No privacy notice (not allowed while the contact form is on).
  noPrivacy?: Confirmation;
  // The contact form's generic consent wording, kept on purpose in some served languages.
  genericConsent?: Confirmation;
  // Going ahead with this many planned pages missing, after the site stopped answering.
  missingPages?: Confirmation & { count: number };
}

// The review before "Ready to embed". settingsHash covers everything visitors see, so a later
// change shows "Changed since sign-off".
export interface SignOff extends Confirmation {
  settingsHash: string;
  // The review's rules at the time (CHECKS_VERSION in the console's lib/review.ts): a sign-off
  // under older checks is flagged until the deployment is brought up to date.
  checksVersion?: number;
  // When the sign-off held: the first automatic run after the first sync left nothing open, or a
  // person resolved what it opened. The onboarding clock's second figure.
  heldAt?: string;
  // The confirmed price table's hash at sign-off, "" for none (build 8): a table change is a change
  // visitors see. Missing on a sign-off from before.
  priceTableHash?: string;
}

// A page kept by hand although a rule leaves it out ("This page states a price and was
// published 11 Oct 2016. Keep it anyway?").
// What a page states, for checking answers against it (content_pages.facts).
export interface PageFacts {
  // Each figure with the line that states it, in the page's own format ("2.205 US-Dollar pro Jahr").
  prices?: { figure: string; line: string }[];
  // Phone numbers, email addresses and contact-form links, with their lines.
  contacts?: { kind: "phone" | "email" | "form"; value: string; line: string }[];
  // Trial, demo and quote links on the page.
  links?: { intent: string; url: string; label?: string }[];
  // Event dates, with the year placed for dates written without one ("2026-11-05").
  events?: { date: string; line: string; readAs: string }[];
}

// A deployment's plan prices, read from its pricing key pages (round 6: answers gave a blog's
// estimate or another plan's figure, and a figure found anywhere on the site passed). Answers that
// name a plan are checked against it everywhere: the chat, the picker, validation and the re-run.
export interface PriceRow {
  plan: string;
  // As the page writes it ("$26.00", "€ 24,75"), and as a number with its currency.
  amount: string;
  value: number;
  currency?: string;
  // "per user", "per node"; "month" or "year"; "from", "billed annually", "list price".
  unit?: string;
  period?: "month" | "year" | "once";
  qualifiers?: string[];
  // The page and the line it was read from.
  url: string;
  line: string;
  // An add-on ("Transcription", "Extra storage"), not a plan: shown and checked like a row, marked
  // as such on the card (round 7, set by the reader or by a person on the confirm step).
  addOn?: boolean;
  // Why the proof or a plausibility check doubts this row (fix cycle 7c): the card shows it, and the
  // deployment is in Needs attention, confirmed or not. A person's correction clears it.
  doubt?: string;
  // A person confirmed the table with this row's doubt showing (build 8): it isn't raised again while
  // the row stands.
  doubtAccepted?: boolean;
  // A row a person corrected: what the page's reading gave, so a later reading is compared with that
  // and the correction stands while the page reads the same (build 8).
  readAs?: { plan: string; amount: string; value: number; currency?: string; period?: "month" | "year" | "once" };
}
export interface PriceTable {
  rows: PriceRow[];
  // The pricing pages read; what was found there; when; and a hash of the rows, so a confirmation
  // holds only while the rows are unchanged.
  pages: string[];
  readAt: string;
  hash: string;
  // With no rows, why (round 7): a pricing page was found but no prices could be read from it
  // ("unread": the figures it states), or its prices are by quote ("quote"). No table stored
  // at all: no pricing page was found.
  gap?: { kind: "unread" | "quote"; url: string; figures?: number };
  // What built the rows (fix cycle 7c): the model, proved by code; the patterns, when the model's
  // call failed; or both, when it failed on some pages. Missing on a table from before.
  builtBy?: "model" | "patterns" | "model+patterns";
  // Rows the model proposed that the proof rejected, and why (lib/price-table-model.ts).
  rejected?: { plan: string; amount: string; url: string; why: string }[];
  // The last failure of the model's call, when the patterns stood in.
  modelError?: string;
  // Figures the pricing pages state that no row has (fix cycle 7d: toggl.com's monthly $12 and $24,
  // bare lines naming no plan). Shown on the card; not in the hash.
  unplaced?: { figure: string; url: string; line: string }[];
  // Plans a person corrected, added or removed by hand (build 8: saving a row no longer confirms, so
  // this lives with the rows), and the rows they removed: a later reading doesn't bring those back.
  edited?: string[];
  removedByHand?: { plan: string; amount: string; value: number; currency?: string; period?: "month" | "year" | "once" }[];
  // What a re-read found different from the rows a person last saw, in words ("Pro was $1,925, now
  // $1,995"): the card, Review and the alert name it. Set when a reading re-opens a table.
  changes?: string[];
  // Each page's proposal, by its address and text's hash: reading unchanged pages costs nothing.
  modelRead?: {
    version: number;
    pages: Record<
      string,
      {
        rows: {
          plan: string;
          amount: string;
          unit?: string;
          period?: "month" | "year" | "once";
          qualifiers?: string[];
          addOn?: boolean;
        }[];
      }
    >;
  };
}
// A person confirmed the table matches the pricing page, with their name, for one hash of the rows.
export interface PriceTableConfirmation {
  hash: string;
  by: string;
  byUserId?: string;
  at: string;
  // Rows the person corrected by hand, by plan.
  edited?: string[];
  // The rows' hash as the sync last read them, before the person's corrections: a sync reading the
  // same page again leaves the corrections standing (round 7).
  readHash?: string;
  // Confirming asks the price questions again (build 8): what visitors got then, a replacement
  // included, for the card to show.
  reasked?: { at: string; questions: PriceReask[]; note?: string };
}

// One price question asked again after confirming: what visitors get, and how (build 8). `answer` is
// the model's own text, or the table's rows in its place ("rows"), or only the link to the pricing page
// ("link"); `held`: it needs a person.
export interface PriceReask {
  question: string;
  answer: string;
  replaced?: "rows" | "link";
  held?: boolean;
}

// The data augmentation agents on a deployment's KB, as the console created them.
export interface Augmentation {
  tasks: { name: string; id: string; agent: string; at: string }[];
}

export interface KeptPage extends Confirmation {
  url: string;
  // The rule's reason, as the plan or the content page words it.
  rule: string;
  reason: string;
}

// The content plan accepted on New deployment, as shown to the partner.
export interface ContentPlanSummary {
  at: string;
  total: number;
  // Suggested exclusions the partner kept ticked, by rule.
  excluded: { rule: string; pages: number }[];
  oldestTaken?: string;
}

export interface PreflightResult {
  at: string;
  origins: { origin: string; ok: boolean; status: number }[];
}

export interface LeadDelivery {
  webhookUrl?: string;
  emails?: string[];
}

export interface ProvisioningStep {
  step: string;
  status: "ok" | "failed" | "skipped";
  at: string;
  detail?: string;
}

// Single row (id = 1): the partner's Agentic RAG account and contract terms.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  partnerName: text("partner_name").notNull().default(""),
  accountId: text("account_id"),
  zone: text("zone"),
  accountType: text("account_type"),
  // Price per usage metric in the contract currency, e.g. { "nuclia_tokens": 0.008 }.
  contractRates: jsonb("contract_rates").$type<Record<string, number>>().notNull().default({}),
  markupPercent: real("markup_percent").notNull().default(0),
  // Where alerts go: a Slack- or Teams-compatible webhook, and email when SMTP is configured.
  alertWebhookUrl: text("alert_webhook_url"),
  alertEmails: text("alert_emails").array().notNull().default(sql`'{}'::text[]`),
  // The account's Knowledge Box limit: read with a PAT, or learned from a 402 at that count.
  kbLimit: integer("kb_limit"),
  kbLimitSource: text("kb_limit_source").$type<"pat" | "refused" | "entered">(),
  // "Improve answers with Agentic RAG agents" (pilot): new deployments get the console's two
  // data augmentation agents at provisioning (lib/augmentation.ts).
  augmentNewDeployments: boolean("augment_new_deployments").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("active"),
  monthlyBudgetCents: integer("monthly_budget_cents"),
  // At 100% of the budget: "alert" only, or "stop" (the widget goes offline until next month).
  budgetMode: text("budget_mode").$type<BudgetMode>().notNull().default("alert"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  // Default for new deployments' answers and widget text.
  language: text("language").$type<Language>().notNull().default("en"),
  billing: jsonb("billing").$type<BillingDetails>().notNull().default({}),
  // The name visitors see in answers, handoff text and lead subjects; never the partner's internal name.
  displayName: text("display_name"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantContacts = pgTable(
  "tenant_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    title: text("title"),
    language: text("language").$type<Language>().notNull().default("en"),
    isPrimary: boolean("is_primary").notNull().default(false),
    // Invited to each new deployment's KB with this role.
    kbRole: contactKbRole("kb_role"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tenant_contacts_email_idx").on(t.tenantId, t.email)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    siteUrl: text("site_url").notNull(),
    // Origins allowed to embed the widget. Mirrored into the KB's allowed_origins.
    domains: text("domains").array().notNull(),
    // The domains among them that are staging or test sites: questions from them are test traffic,
    // and answering only there is "Live on staging".
    stagingDomains: text("staging_domains").array().notNull().default(sql`'{}'::text[]`),
    sitefinityVersion: text("sitefinity_version"),
    contentPath: contentPath("content_path").notNull(),
    widgetMode: widgetMode("widget_mode").notNull().default("embed"),
    zone: text("zone").notNull(),
    kbId: text("kb_id").unique(),
    kbSlug: text("kb_slug").notNull().unique(),
    searchConfig: text("search_config").notNull().default("launchpad-default"),
    // Answer language (through the search config's prompt) and widget text; "auto" follows the visitor.
    language: text("language").$type<LanguageSetting>().notNull().default("en"),
    // The partner's prompt as written. The saved search config adds the language rule to it.
    systemPrompt: text("system_prompt").notNull().default(""),
    theme: jsonb("theme").$type<ThemeInput>().notNull().default({}),
    widgetSettings: jsonb("widget_settings").$type<WidgetSettings>().notNull().default({}),
    status: deploymentStatus("status").notNull().default("draft"),
    // Step-by-step record of provisioning, so a failed run can resume where it stopped.
    provisioningLog: jsonb("provisioning_log").$type<ProvisioningStep[]>().notNull().default([]),
    // The last validation run: generated test questions, their answers and sources.
    validation: jsonb("validation").$type<ValidationResult>(),
    // The last domain-lock check, per allowed origin.
    preflight: jsonb("preflight").$type<PreflightResult>(),
    // First time validation and the domain check both passed: "Ready to embed".
    readyAt: timestamp("ready_at", { withTimezone: true }),
    // First chat session from an allowed domain (the widget asks for a token on its first
    // question): "Live".
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    firstSeenOrigin: text("first_seen_origin"),
    // Where leads from the chat's contact form go. Server-side only: never in the public config.
    leadDelivery: jsonb("lead_delivery").$type<LeadDelivery>().notNull().default({}),
    // The chat shows on sites only once a person has signed it off. Deployments already live
    // before sign-off existed keep serving (set by the migration) and show "Not signed off".
    published: boolean("published").notNull().default(false),
    signOff: jsonb("sign_off").$type<SignOff>(),
    confirmations: jsonb("confirmations").$type<DeploymentConfirmations>().notNull().default({}),
    // The answering rules (prompt rules, retrieval settings, intent configurations) this
    // deployment's chat runs on: a new version reaches it only after a re-check passes.
    answeringRules: integer("answering_rules").notNull().default(0),
    // Agentic RAG data augmentation agents the console created on this deployment's KB.
    augmentation: jsonb("augmentation").$type<Augmentation>(),
    // Plan prices read from the pricing key pages, and the person who confirmed them (item 1, round 6).
    priceTable: jsonb("price_table").$type<PriceTable>(),
    priceTableConfirmation: jsonb("price_table_confirmation").$type<PriceTableConfirmation>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deployments_tenant_idx").on(t.tenantId)],
);

// What the style sniffer proposed for a deployment's site: the latest scan, replaced on rescan.
// The scan's suggestions beyond the theme (chat name, languages, web fonts) come with it.
export interface SiteScanResult extends SiteScanExtras {
  theme: ThemeTokens;
  confidence: Record<string, number>;
  sources: Record<string, string>;
  warnings: string[];
  sitemaps: string[];
  sitemapTruncated: boolean;
  status: number;
  logo?: string;
  icons: string[];
}

// Kept apart from deployments: the screenshot is a few hundred KB and only the widget page needs it.
export const siteScans = pgTable("site_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .unique()
    .references(() => deployments.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  finalUrl: text("final_url").notNull(),
  platform: jsonb("platform").$type<SitePlatform>().notNull(),
  sitemapPages: integer("sitemap_pages").notNull().default(0),
  result: jsonb("result").$type<SiteScanResult>().notNull(),
  // Base64 JPEG of the page; the widget preview sits on top of it.
  screenshot: text("screenshot").notNull(),
  createdAt: createdAt(),
});

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    role: keyRole("role").notNull(),
    serviceAccountId: text("service_account_id").notNull(),
    keyId: text("key_id").notNull(),
    // sealSecret(token, masterKey, credentialContext(deploymentId, role))
    secret: text("secret").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("credentials_deployment_role_idx").on(t.deploymentId, t.role)],
);

export const syncSources = pgTable(
  "sync_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    kind: syncKind("kind").notNull(),
    externalConnectionId: text("external_connection_id"),
    syncConfigId: text("sync_config_id"),
    sitemapUrl: text("sitemap_url"),
    pageBudget: integer("page_budget"),
    includePatterns: text("include_patterns").array().notNull().default(sql`'{}'::text[]`),
    excludePatterns: text("exclude_patterns").array().notNull().default(sql`'{}'::text[]`),
    // queued (waiting for the worker), running, ok, partial (some pages failed) or failed.
    lastJobStatus: text("last_job_status"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // When the current or last run started, and why it stopped if it failed.
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Pages the sitemap (or crawl) found within the rules, before the budget.
    pagesFound: integer("pages_found"),
    // How the pages were found: "sitemap", or "crawl" when the site has none.
    discovery: text("discovery"),
    // Re-sync interval; null means only on request.
    resyncHours: integer("resync_hours").default(168),
    // Languages to sync (lower-case tags, e.g. "en", "es"); empty means every language.
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    // Pages a person added by hand (validation's "Add these pages", Content's "Always include"):
    // kept whatever the budget, up to 25, and synced ahead of the queue.
    pinned: text("pinned").array().notNull().default(sql`'{}'::text[]`),
    // Pages a person kept although a date or stale-price rule leaves them out, each with who and
    // why: Review's Content line shows them.
    kept: jsonb("kept").$type<KeptPage[]>().notNull().default(sql`'[]'::jsonb`),
    // The content plan as accepted on New deployment.
    plan: jsonb("plan").$type<ContentPlanSummary>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sync_sources_kind_idx").on(t.deploymentId, t.kind)],
);

// Every page synced into a deployment's KB. The slug is stable per URL, so a re-sync updates
// a page's resource instead of duplicating it, and unchanged pages (same hash) aren't resent.
export const contentPages = pgTable(
  "content_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    slug: text("slug").notNull(),
    resourceId: text("resource_id"),
    contentHash: text("content_hash"),
    words: integer("words").notNull().default(0),
    // The Markdown sent to the KB, for "View extracted text".
    text: text("text"),
    status: pageStatus("status").notNull().default("queued"),
    // Why a page was skipped or failed, in words a partner can act on.
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    // From the sitemap's lastmod, or the page's published or modified date.
    lastModified: timestamp("last_modified", { withTimezone: true }),
    // The page's own dates, read when it's loaded (JSON-LD, article meta, <time>), and the
    // sitemap's lastmod as listed: the freshness rules go by the page's own.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    pageModifiedAt: timestamp("page_modified_at", { withTimezone: true }),
    sitemapLastmod: timestamp("sitemap_lastmod", { withTimezone: true }),
    // The extractor and content rules that produced this page's text and flags: a page is
    // unchanged only if both are current (apps/worker/src/jobs/content.ts).
    extractorVersion: integer("extractor_version").notNull().default(0),
    rulesVersion: integer("rules_version").notNull().default(0),
    // The page's <html lang>, lower case.
    lang: text("lang"),
    // conversion, old, other-language, overview, short-text: shown and filterable on the content list.
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    // A key page (KEY_INTENTS in content-plan.ts: price, contact, support, buy, trial, faq): taken
    // ahead of the sections, never left out by age alone, and indexed with its intent's words.
    keyIntent: text("key_intent"),
    // What the page states that answers are checked against: price lines, contact lines, trial
    // and demo links, and upcoming event dates with the year placed (refreshed on every read).
    facts: jsonb("facts").$type<PageFacts>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("content_pages_url_idx").on(t.deploymentId, t.url), index("content_pages_status_idx").on(t.deploymentId, t.status)],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    questions: integer("questions").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    // Sum of nuclia_tokens from the ask log (manager key; no PAT needed).
    queryTokens: numeric("query_tokens", { precision: 14, scale: 6 }).notNull().default("0"),
    // Processing/storage metrics from the Account API usage endpoint (needs a PAT).
    accountMetrics: jsonb("account_metrics").$type<Record<string, number>>(),
    costCents: integer("cost_cents"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.day] })],
);

export const qualityDaily = pgTable(
  "quality_daily",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    answerRelevance: real("answer_relevance"),
    contextRelevance: real("context_relevance"),
    groundedness: real("groundedness"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.day] })],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: userRole("role").notNull(),
    // Required for customer viewers: the only tenant they can see.
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [check("users_customer_viewer_has_tenant", sql`${t.role} <> 'customer_viewer' OR ${t.tenantId} IS NOT NULL`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_log_target_idx").on(t.targetType, t.targetId)],
);

// Every saved version of a deployment's system prompt, for diff and revert.
export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    language: text("language").$type<LanguageSetting>().notNull(),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [index("prompt_versions_deployment_idx").on(t.deploymentId, t.createdAt)],
);

// Origins that asked for a deployment's widget and were refused: hostname and count only.
export const refusedOrigins = pgTable(
  "refused_origins",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    count: integer("count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.origin] })],
);

// Read-only links for people outside the console: the install guide and the client report.
// Only a hash of the token is stored.
export const shareLinks = pgTable("share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"install" | "report">().notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  deploymentId: uuid("deployment_id").references(() => deployments.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  actorUserId: uuid("actor_user_id"),
  createdAt: createdAt(),
});

// Signed-in console sessions. Only a hash of the cookie's token is stored.
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// Alerts already sent, so each goes out once per threshold and period ("budget-80:<tenant>:2026-10").
export const alertsSent = pgTable("alerts_sent", {
  key: text("key").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

// Leads from the chat's contact form, kept only until delivered (or 7 days of retries).
export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => deployments.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

// Widget events per deployment and day, counts only (no text): CTA, handoff, thumbs, leads.
export const widgetEventsDaily = pgTable(
  "widget_events_daily",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    name: text("name").notNull(),
    // One breakdown: the CTA label, "up"/"down", the contact type, "answered"/"unanswered"…
    dimension: text("dimension").notNull().default(""),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.day, t.name, t.dimension] })],
);

// The widget's verdict on each answer it showed: the record of "answered" for the report, by
// the same rule as validation and GA. The question itself isn't sent, only a hash of its
// normalized text, which the worker matches against the question log. Thumbs land on the same row.
export const answerEvents = pgTable(
  "answer_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    questionHash: text("question_hash").notNull(),
    answered: boolean("answered").notNull(),
    language: text("language"),
    // "up" or "down".
    feedback: text("feedback"),
    // Asks it took to answer (2 when the widget retried), and the page origin it was asked on.
    attempts: integer("attempts").notNull().default(1),
    origin: text("origin"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("answer_events_question_idx").on(t.deploymentId, t.conversationId, t.questionHash),
    index("answer_events_time_idx").on(t.deploymentId, t.at),
  ],
);

// The widget's note that a question was asked, sent as it's asked (before the answer, flushed if
// the page closes): the page origin it came from, so test traffic is told apart even when the
// answer event never arrives. Matched to the question log by question hash, as answer events are.
// A model's judgement of one answer to one question, against the site's text (validation, the
// starter picker and the report roll-up): asked once per question and answer pair.
export const judgements = pgTable(
  "judgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    questionHash: text("question_hash").notNull(),
    answerHash: text("answer_hash").notNull(),
    // "answers" | "partly" | "not-on-site" | "contradicts" | "off-topic" | "talks-about-sources"
    verdict: text("verdict").notNull(),
    reason: text("reason").notNull(),
    model: text("model"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("judgements_pair_idx").on(t.deploymentId, t.questionHash, t.answerHash)],
);

export const questionEvents = pgTable(
  "question_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    questionHash: text("question_hash").notNull(),
    origin: text("origin"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("question_events_question_idx").on(t.deploymentId, t.conversationId, t.questionHash),
    index("question_events_time_idx").on(t.deploymentId, t.at),
  ],
);

// Visitors' questions from the KB's question log, for the client report. Email addresses and
// phone numbers are masked before they're stored; partner tests are flagged and left out.
export const askedQuestions = pgTable(
  "asked_questions",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    logId: text("log_id").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(),
    question: text("question").notNull(),
    answered: boolean("answered").notNull(),
    // "good" or "bad" when the visitor rated the answer.
    feedback: text("feedback"),
    partnerTest: boolean("partner_test").notNull().default(false),
    citedUrls: text("cited_urls").array().notNull().default(sql`'{}'::text[]`),
    // Whose rule "answered" came from: "widget" (what the visitor saw) or "log" (the same rule
    // applied to the question log when the widget's event didn't arrive). Null: the earlier rule.
    verdictSource: text("verdict_source"),
    // Hidden from the client report by the partner ("Not a content gap").
    hidden: boolean("hidden").notNull().default(false),
    // How many times the visitor's question reached Agentic RAG (the widget's retry asks again):
    // the report counts it once, the costs count every attempt.
    attempts: integer("attempts").notNull().default(1),
    // The page origin the question came from, when the widget's event said.
    origin: text("origin"),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.logId] }), index("asked_questions_time_idx").on(t.deploymentId, t.askedAt)],
);
