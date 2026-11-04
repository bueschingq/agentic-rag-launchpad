// Canned replies for the configurator's preview, in Agentic RAG's own /ask stream format, so
// the widget renders them exactly as it would a real answer: streamed text and two source
// links on the customer's site, or the "nothing found" reply an empty KB gives.

import type { Language } from "@launchpad/theme";

const SAMPLES: Record<Language, { answer: string; pages: [string, string] }> = {
  en: {
    answer:
      "This is a sample answer, so you can see how replies look. Real answers come from the content in this chatbot's Knowledge Box, and link to the pages they used.",
    pages: ["Home", "Contact us"],
  },
  es: {
    answer:
      "Esta es una respuesta de ejemplo, para que veas cómo se ven las respuestas. Las respuestas reales salen del contenido de la Knowledge Box de este chatbot y enlazan a las páginas que usaron.",
    pages: ["Inicio", "Contacto"],
  },
  fr: {
    answer:
      "Ceci est une réponse d'exemple, pour voir à quoi ressemblent les réponses. Les vraies réponses proviennent du contenu de la Knowledge Box de ce chatbot et renvoient aux pages utilisées.",
    pages: ["Accueil", "Contact"],
  },
  de: {
    answer:
      "Dies ist eine Beispielantwort, damit Sie sehen, wie Antworten aussehen. Echte Antworten stammen aus den Inhalten der Knowledge Box dieses Chatbots und verlinken die verwendeten Seiten.",
    pages: ["Startseite", "Kontakt"],
  },
  nl: {
    answer:
      "Dit is een voorbeeldantwoord, zodat u ziet hoe antwoorden eruitzien. Echte antwoorden komen uit de inhoud van de Knowledge Box van deze chatbot en linken naar de gebruikte pagina's.",
    pages: ["Home", "Contact"],
  },
  pt: {
    answer:
      "Esta é uma resposta de exemplo, para você ver como as respostas aparecem. As respostas reais vêm do conteúdo da Knowledge Box deste chatbot e trazem links para as páginas usadas.",
    pages: ["Início", "Contato"],
  },
  it: {
    answer:
      "Questa è una risposta di esempio, per vedere come appaiono le risposte. Le risposte reali provengono dai contenuti della Knowledge Box di questo chatbot e rimandano alle pagine utilizzate.",
    pages: ["Home", "Contatti"],
  },
};

// Agentic RAG's fixed sentence when nothing matched; the widget replaces it with its own text.
const NO_CONTEXT = "Not enough data to answer this.";

// One NDJSON line per item. The answer arrives a few words at a time, like a real stream.
export function sampleStream(language: Language, siteUrl: string, kind: "answer" | "no-answer"): string[] {
  const line = (item: Record<string, unknown>) => `${JSON.stringify({ item })}\n`;
  if (kind === "no-answer") {
    return [line({ type: "status", status: "no_retrieval_data", code: "-3" }), line({ type: "answer", text: NO_CONTEXT })];
  }
  const { answer, pages } = SAMPLES[language];
  const origin = new URL(siteUrl).origin;
  const resources = {
    "sample-home": { id: "sample-home", title: pages[0], origin: { url: `${origin}/` } },
    "sample-contact": { id: "sample-contact", title: pages[1], origin: { url: `${origin}/contact` } },
  };
  const words = answer.split(/(?<= )/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 3) chunks.push(words.slice(i, i + 3).join(""));
  return [
    line({ type: "retrieval", results: { resources } }),
    ...chunks.map((text) => line({ type: "answer", text })),
    line({ type: "citations", citations: { "sample-home/t/page/0-80": [[0, 80]], "sample-contact/t/page/0-60": [[0, 60]] } }),
    line({ type: "status", status: "success", code: "0" }),
  ];
}
