// A client page under a strict Content Security Policy, with the widget as built, a stand-in
// console and a stand-in Agentic RAG. The policy is the one security teams ask for:
//
//   default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:
//
// No 'unsafe-inline' for styles: the widget's styles are constructable stylesheets.
//
//   npm run build --workspace @launchpad/widget && node spike/csp/server.ts
//
//   http://127.0.0.1:4175/page?mode=floating            fully styled under the strict policy
//   http://127.0.0.1:4175/page?mode=popup&csp=noconnect  connect-src blocks the console: one
//                                                        console.error names the directive
//   http://127.0.0.1:4175/page?mode=chat&lang=es         the page's language, with Spanish copy
//   http://127.0.0.1:4175/gtm?how=gtm                    added the way a Tag Manager tag adds it
//   http://127.0.0.1:4175/login                          an excluded page: no chat
//   http://127.0.0.1:4175/home/Action/Edit               Sitefinity's page editor: no chat
//
// The same pages back the widget's browser tests (packages/widget/e2e).

import { CSP, startFixture } from "../../packages/widget/e2e/fixture.ts";

const site = await startFixture(4175);
console.log(`strict-CSP test pages on ${site.origin}/page?mode=floating`);
console.log(`policy: ${CSP.strict}`);
