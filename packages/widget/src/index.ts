// Entry for arag-chat.js. Defines <arag-chat>, and mounts one automatically for the embed
// snippet:
//
//   <script src="https://console.partner.example/arag-chat.js" data-deployment="…" async></script>
//
// data-language="es" fixes the language of a deployment set to follow the page, ahead of
// <html lang> and the browser. Tag Manager's Custom HTML tags re-create the script element
// with its attributes, so document.currentScript still finds them; loaders that leave it
// unset are covered by looking the tag up.
//
// The same can go in the script's address, for CMS fields that take a file link and no
// attributes (Sitefinity's JavaScript widget): arag-chat.js?deployment=…&language=es.

import { AragChat } from "./element.ts";

if (!customElements.get("arag-chat")) customElements.define("arag-chat", AragChat);

const script =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>('script[data-deployment][src*="arag-chat"], script[src*="arag-chat"][src*="deployment="]');
const query = script ? new URL(script.src, location.href).searchParams : undefined;
const deployment = script?.dataset.deployment ?? query?.get("deployment") ?? undefined;
const language = script?.dataset.language ?? query?.get("language") ?? undefined;

if (script && deployment) {
  const mount = () => {
    if (document.querySelector(`arag-chat[deployment="${CSS.escape(deployment)}"]`)) return;
    const chat = document.createElement("arag-chat");
    chat.setAttribute("deployment", deployment);
    chat.setAttribute("base-url", new URL(script.src).origin);
    if (language) chat.setAttribute("language", language);
    document.body.append(chat);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
