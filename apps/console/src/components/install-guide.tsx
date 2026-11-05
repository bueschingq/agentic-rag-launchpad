// The install guide for a deployment: everything the client's web team needs to put the chat on
// the site, with Sitefinity's own steps first. Shown in the console and through a read-only
// share link; it never contains a key.

import { zoneOrigin } from "@launchpad/par-client";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button.tsx";
import { DataHandling } from "@/components/data-handling.tsx";
import { cspSnippet } from "@/lib/csp.ts";
import { WIDGET_GZIP_KB } from "@/lib/widget-size.ts";

export interface GuideDeployment {
  id: string;
  name: string;
  siteUrl: string;
  domains: string[];
  zone: string;
  kbId: string | null;
  sitefinityVersion: string | null;
  contentPath: string;
  avatar?: string;
}

function Code({ code, label }: { code: string; label: string }) {
  return (
    <div className="code-block">
      <pre className="snippet">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={label} />
    </div>
  );
}

export function InstallGuide({
  d,
  customer,
  partner,
  consoleOrigin,
  check,
}: {
  d: GuideDeployment;
  // The name visitors see, never the partner's internal name for the customer.
  customer: string;
  partner: string;
  consoleOrigin: string;
  check: ReactNode;
}) {
  const script = `${consoleOrigin}/arag-chat.js`;
  const snippet = `<script src="${script}" data-deployment="${d.id}" async></script>`;
  // The same script with the deployment in its address, for fields that take a file link.
  const fileLink = `${script}?deployment=${d.id}`;
  // For places that take JavaScript rather than HTML (Sitefinity's JavaScript widget, a tag
  // manager): the same script, added to the page by code.
  const loader = `(function (d) {
  var s = d.createElement("script");
  s.src = "${script}";
  s.async = true;
  s.setAttribute("data-deployment", "${d.id}");
  d.body.appendChild(s);
})(document);`;
  const connector = d.contentPath === "sitefinity_connector";

  return (
    <div className="guide">
      <section className="panel" aria-labelledby="before">
        <h2 id="before">Before you start</h2>
        <p>
          {partner || "Your agency"} has set up an AI chat assistant for {customer}'s website, <strong>{new URL(d.siteUrl).host}</strong>.
          It answers visitors' questions from the site's own pages, with links to the pages it used. This guide puts it on the site: one
          script, added once.
        </p>
        <ul>
          <li>
            It only loads on these addresses: {d.domains.map((x, i) => [i > 0 && ", ", <code key={x}>{x}</code>])}. Tell{" "}
            {partner || "your agency"} about any other (staging, the address without www, a language site).
          </li>
          <li>It's one script (about {WIDGET_GZIP_KB} KB compressed), loaded without blocking the page, and it sets no cookies.</li>
          <li>It doesn't appear in Sitefinity's page editor, only on published pages.</li>
        </ul>
      </section>

      <section className="panel" aria-labelledby="snippet">
        <h2 id="snippet">The snippet</h2>
        <p>Before the closing &lt;/body&gt; tag, on every page that should show the chat:</p>
        <Code code={snippet} label="Copy snippet" />
      </section>

      <section className="panel" aria-labelledby="sitefinity">
        <h2 id="sitefinity">Sitefinity</h2>
        <h3>MVC pages: in the page template (recommended)</h3>
        <ol>
          <li>In the Sitefinity backend, go to Design › Page Templates and open the template your pages use.</li>
          <li>From the widget toolbox, under Scripts and Styles, drag a JavaScript widget onto the template.</li>
          <li>Edit it, choose "Link to a file", and paste the address below.</li>
          <li>Set "Include the script in" to "Before the closing body tag" and save.</li>
          <li>Publish the template. Every page built on it now shows the chat; no page needs republishing.</li>
        </ol>
        <Code code={fileLink} label="Copy address" />
        <p className="help">
          On chosen pages only: do the same with a JavaScript widget on each of those pages instead of the template. "Write JavaScript" with
          the code below works too, but only where the site's Content Security Policy allows inline scripts.
        </p>
        <Code code={loader} label="Copy code" />
        <h3>ASP.NET Core renderer: a code deploy</h3>
        <p>
          On the ASP.NET Core renderer this is a change to the renderer's code, made by a developer and released with a deployment: plan it
          as its own step with the people who deploy the site, not as a backend edit.
        </p>
        <ol>
          <li>In the renderer project, open the layout view the site's templates use (often Views/Shared/_Layout.cshtml).</li>
          <li>Paste the snippet just before &lt;/body&gt;.</li>
          <li>Deploy the renderer through your usual release process. Pages show the chat from then on.</li>
        </ol>
        <h3>MVC layout file (for developers)</h3>
        <p>Add the snippet before &lt;/body&gt; in the layout file under ResourcePackages, then deploy.</p>
        {connector && (
          <>
            <h3>Content: Sitefinity's Agentic RAG connector (15.4 and later)</h3>
            <p>Administration › Settings › Agentic RAG connection takes three values:</p>
            <dl className="details">
              <dt>Endpoint</dt>
              <dd>
                <code>{zoneOrigin(d.zone)}</code>
              </dd>
              <dt>Knowledge Box ID</dt>
              <dd>
                <code>{d.kbId}</code>
              </dd>
              <dt>Key</dt>
              <dd>{partner || "Your agency"} sends it separately: it isn't part of this guide.</dd>
            </dl>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="tag-manager">
        <h2 id="tag-manager">Google Tag Manager</h2>
        <ol>
          <li>Tags › New › Custom HTML.</li>
          <li>Paste the snippet, or the JavaScript code wrapped in &lt;script&gt; … &lt;/script&gt;.</li>
          <li>Trigger: All Pages (or the pages that should show the chat). Save, preview, then submit the container.</li>
        </ol>
      </section>

      <section className="panel" aria-labelledby="csp">
        <h2 id="csp">If the site sends a Content Security Policy</h2>
        <p>
          Add these sources to its existing directives. The snippet and the file address need no 'unsafe-inline'; the JavaScript code does,
          or a nonce.
        </p>
        <Code code={cspSnippet({ consoleOrigin, zone: d.zone, avatarUrl: d.avatar })} label="Copy CSP entries" />
      </section>

      <section className="panel" aria-labelledby="check">
        <h2 id="check">Check the installation</h2>
        <p>Once it's published, check a page: this loads it the way a visitor's browser does and says what, if anything, is in the way.</p>
        {check}
      </section>

      <section className="panel" aria-labelledby="data">
        <h2 id="data">Data handling</h2>
        <DataHandling zone={d.zone} consoleHost={new URL(consoleOrigin).host} />
      </section>
    </div>
  );
}
