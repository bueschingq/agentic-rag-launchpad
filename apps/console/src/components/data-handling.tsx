// Where a deployment's data goes, for the client's privacy or DPO questions: shown on the
// deployment page and in the install guide.

export function DataHandling({ zone, consoleHost }: { zone: string; consoleHost: string }) {
  return (
    <dl className="details">
      <dt>Where questions are answered</dt>
      <dd>
        Progress Agentic RAG, region <code>{zone}</code>. The site's content is stored there too, in this deployment's own Knowledge Box.
        The region comes with the Agentic RAG account this console is connected to: it isn't chosen per client, and the console can't move a
        Knowledge Box to another region.
      </dd>
      <dt>The access token in the ask address</dt>
      <dd>
        Visitors' browsers ask Agentic RAG directly, with a 15-minute token that can only read this Knowledge Box. Agentic RAG takes that
        token only in the ask's web address (<code>?eph-token=</code>), so a log that records full addresses on the way, such as a company
        proxy, could hold it until it expires. The console doesn't log it.
      </dd>
      <dt>What's kept, and for how long</dt>
      <dd>
        Agentic RAG keeps each question and answer in the Knowledge Box's activity log, under the partner's Progress agreement. This console
        keeps a copy of visitors' questions for 13 months for the client report, with email addresses and phone numbers masked, and counts
        of chat events (no text).
      </dd>
      <dt>What the widget stores</dt>
      <dd>
        No cookies. The conversation is kept in the browser tab's session storage, and is gone when the tab closes. Analytics events never
        contain question or answer text.
      </dd>
      <dt>Where a visit came from</dt>
      <dd>
        On the first page of a visit, the widget notes that page and the one that linked to it, both without their query string, and the
        campaign tags in its address (<code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code>, <code>utm_term</code>,{" "}
        <code>utm_content</code> and <code>gclid</code>, never a value that looks like an email address). They stay in the tab's session
        storage, and leave the page only inside a lead the visitor sends from the contact form, after ticking its consent box. Nothing else
        in the address is kept or sent.
      </dd>
      <dt>What the console sees</dt>
      <dd>
        Visitors' browsers load the widget's settings and a 15-minute access token from <code>{consoleHost}</code>, so its server sees their
        IP address and the page they're on. Leads from the chat's contact form pass through it to the client, with the consent wording the
        visitor ticked, what opened the form and where the visit came from, and are deleted once delivered.
      </dd>
      <dt>Deleting a visitor's data</dt>
      <dd>
        Ask the partner: they remove the visitor's questions from the console's copy and request deletion from the Knowledge Box's activity
        log through Progress.
      </dd>
    </dl>
  );
}
