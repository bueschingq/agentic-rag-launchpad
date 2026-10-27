// Entry for arag-chat.js. Defines <arag-chat>, and mounts one automatically for the embed
// snippet:
//
//   <script src="https://console.partner.example/arag-chat.js" data-deployment="…" async></script>

import { AragChat } from "./element.ts";

if (!customElements.get("arag-chat")) customElements.define("arag-chat", AragChat);

const script = document.currentScript as HTMLScriptElement | null;
const deployment = script?.dataset.deployment;

if (script && deployment) {
  const mount = () => {
    if (document.querySelector(`arag-chat[deployment="${CSS.escape(deployment)}"]`)) return;
    const chat = document.createElement("arag-chat");
    chat.setAttribute("deployment", deployment);
    chat.setAttribute("base-url", new URL(script.src).origin);
    document.body.append(chat);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
