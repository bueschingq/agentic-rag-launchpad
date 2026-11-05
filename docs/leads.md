# Leads from the chat's contact form

When a visitor sends the chat's contact form, the console delivers the lead at once to the deployment's webhook and/or email (set on the deployment's Edit page, under Leads), and keeps nothing once it's delivered. Undelivered leads are retried for 7 days, then deleted.

The webhook receives JSON in **schema version 2**, published as [`lead-payload.schema.json`](lead-payload.schema.json). Version 1's fields are unchanged, so existing integrations keep working; version 2 adds `schemaVersion`, `consent`, `trigger` and `attribution`. Optional fields may be added within version 2, so don't reject unknown ones.

```json
{
  "schemaVersion": 2,
  "kind": "lead",
  "receivedAt": "2026-10-30T14:02:05.120Z",
  "deployment": "Main site",
  "customer": "WhatsUp Gold",
  "conversationId": "0b6d0d0e-3f7a-4c41-9a43-6f1f6f0d2c11",
  "fields": { "name": "Ana Ruiz", "email": "ana@client.example", "message": "Please send a quote for 300 devices." },
  "pageUrl": "https://www.whatsupgold.com/pricing",
  "language": "en",
  "consent": {
    "given": true,
    "text": "I agree that WhatsUp Gold may contact me about my request.",
    "language": "en",
    "privacyUrl": "https://www.progress.com/legal/privacy-center",
    "at": "2026-10-30T14:02:05.120Z"
  },
  "trigger": { "placement": "cta", "ctaLabel": "Get a quote" },
  "attribution": {
    "landingPage": "https://www.whatsupgold.com/",
    "referrer": "https://www.linkedin.com/",
    "utm_source": "linkedin",
    "utm_campaign": "q4"
  },
  "subject": "New lead from the WhatsUp Gold website chat",
  "text": "Someone left their details in the chat on Main site. …"
}
```

- **`customer`** is the name visitors see (the customer's _Name visitors see_), never the partner's internal name. The email subject uses it too.
- **`test: true`** is present only when the form was sent from one of the deployment's staging domains or localhost. The subject starts "[Test, from a staging page]". Filter these out of your CRM workflow, or route them to a test list.
- **`consent.text`** is the exact wording the visitor ticked, in the language they were served (`consent.language`). The email carries the same wording on its _Consent_ line.
- **`trigger.placement`**: `header` ("Talk to a person"), `no-answer` (a reply with no answer), `after-answer` ("Still need help?") or `cta` (a call-to-action button, named in `ctaLabel`).
- **`attribution`** is captured on the first page of the visit, into the browser tab's sessionStorage (no cookies), and sent only inside a lead the visitor sent with consent. Page addresses lose their query string; only `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and `gclid` are kept, and a value that looks like an email address is dropped.
- **`transcript`** is there only when the visitor ticked "Include this conversation".

## HubSpot

Post the lead to HubSpot from a workflow tool (Zapier, Make, Power Automate) or HubSpot's own _Workflows › Webhook trigger_ (Operations Hub). Create or update the contact by email, then log the consent:

| Lead payload                                             | HubSpot contact property                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fields.email`                                           | `email`                                                                                                                                                   |
| `fields.name`                                            | `firstname` / `lastname` (split on the last space)                                                                                                        |
| `fields.phone`                                           | `phone`                                                                                                                                                   |
| `fields.message`                                         | `message`, or a note on the contact                                                                                                                       |
| `attribution.utm_source` / `utm_medium` / `utm_campaign` | `utm_source` / `utm_medium` / `utm_campaign` (custom properties; HubSpot's own _Original source_ is set by its tracking code, not by this)                |
| `attribution.gclid`                                      | `hs_google_click_id`                                                                                                                                      |
| `attribution.landingPage`                                | a custom `chat_landing_page` property                                                                                                                     |
| `trigger.ctaLabel`, else `trigger.placement`             | a custom `chat_lead_trigger` property                                                                                                                     |
| `consent.text`, `consent.at`                             | the contact's legal basis: _Legitimate interest_ or _Freely given consent_, with `consent.text` as its explanation, via the Communication Preferences API |
| `pageUrl`                                                | `hs_analytics_last_url` is read-only; use a custom `chat_page_url` property                                                                               |

Through the Forms API instead (`POST https://api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}`), send `fields` as form fields, `pageUrl` as `context.pageUri`, and `consent.text` as `legalConsentOptions.consent.text` with `consentToProcess: true`.

## Salesforce

Create a Lead with Flow, an integration user's REST call (`POST /services/data/vXX.X/sobjects/Lead`), or a middleware tool:

| Lead payload                                                                          | Salesforce Lead field                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fields.name`                                                                         | `FirstName` / `LastName` (`LastName` is required: use the whole name, or "Unknown", if there's no space)                                                                                                     |
| `fields.email`                                                                        | `Email`                                                                                                                                                                                                      |
| `fields.phone`                                                                        | `Phone`                                                                                                                                                                                                      |
| `fields.message`                                                                      | `Description`                                                                                                                                                                                                |
| `customer`                                                                            | `Company` (required)                                                                                                                                                                                         |
| —                                                                                     | `LeadSource` = `"Website chat"`                                                                                                                                                                              |
| `attribution.utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` | custom `UTM_Source__c` … `UTM_Content__c`                                                                                                                                                                    |
| `attribution.gclid`                                                                   | custom `GCLID__c` (or Google Ads' own field if its connector is installed)                                                                                                                                   |
| `attribution.landingPage`                                                             | custom `Landing_Page__c`                                                                                                                                                                                     |
| `trigger.ctaLabel`, else `trigger.placement`                                          | custom `Chat_Trigger__c`                                                                                                                                                                                     |
| `consent.text`, `consent.at`, `consent.privacyUrl`                                    | custom `Consent_Text__c`, `Consent_Date__c`, `Privacy_Notice__c`; or, with Salesforce's consent model, a `ContactPointTypeConsent` record (`CaptureSource` = `"Website chat"`, `CaptureDate` = `consent.at`) |

Web-to-Lead works too (`https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8`, with `oid` and the same field names), but it can't take the consent record, so the REST call is the better fit where consent must be auditable.
